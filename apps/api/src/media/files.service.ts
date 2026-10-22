import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import type { ActorType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import {
  ConflictError,
  PermissionDeniedError,
  ResourceNotFoundError,
  StorageUnavailableError,
  ValidationFailedError,
} from '../common/errors';
import { AppConfig } from '../config';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { actorLabel } from '../tenancy/context/context.types';
import {
  isFilePurpose,
  isReferenced,
  PURPOSES,
  type FilePurpose,
  type PurposeDefinition,
} from './file-purposes';
import { checkClaims, processImage, sanitiseFileName } from './image-processing';
import { StorageService } from './storage/storage.service';
import type { UploadedTempFile } from './upload.interceptor';

interface FileRow {
  id: string;
  companyId: string;
}

@Injectable()
export class FileRepository extends TenantScopedRepository<FileRow> {
  protected readonly modelName = 'File';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<FileRow> {
    return tx.file;
  }
}

type StoredFile = NonNullable<Awaited<ReturnType<TenantTx['file']['findFirst']>>>;

/**
 * Upload, read and remove the images this product uses.
 *
 * ---------------------------------------------------------------------------
 * ONE REQUEST, NO ORPHANS
 * ---------------------------------------------------------------------------
 *
 * An upload names what it is for (`purpose`, `targetId`), and is attached in
 * the same request:
 *
 *   1. checks: permission for the purpose, the target exists in this company
 *   2. the image is validated and re-encoded on disk (image-processing.ts)
 *   3. a `file` row is written as UPLOADING
 *   4. the bytes are streamed to storage           — fails: row deleted, 503
 *   5. the target is pointed at it, compare-and-set — fails: object and row
 *      deleted
 *   6. the image it replaced is deleted, unless something still uses it
 *
 * A crash between steps leaves an UPLOADING row, which FileCleanupService
 * removes (with any object) after the grace period. Nothing is ever attached
 * that was not fully stored, and nothing stored stays unattached.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly files: FileRepository,
    private readonly storage: StorageService,
    private readonly context: RequestContextService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  async upload(input: { purpose: string; targetId?: string | null }, upload: UploadedTempFile) {
    if (!isFilePurpose(input.purpose)) {
      throw new ValidationFailedError([{ path: ['purpose'], message: 'Unknown purpose.' }]);
    }
    const purpose = input.purpose;
    const definition = PURPOSES[purpose];
    this.require(definition.write);
    checkClaims(upload.claimedMime, upload.originalName);

    // 1. The target, in this company — before any processing work.
    const targetId = await this.files.transaction(async (tx, companyId) => {
      const target = definition.targetIsCompany ? companyId : input.targetId;
      if (!target || !/^[0-9a-f-]{36}$/i.test(target)) {
        throw new ValidationFailedError([
          { path: ['targetId'], message: 'Say which record this image is for.' },
        ]);
      }
      if ((await definition.slot.current(tx, companyId, target)) === undefined) {
        throw new ResourceNotFoundError(definition.slot.resource, target);
      }
      return target;
    });

    // 2. Validate and re-encode, disk to disk.
    const processedPath = `${upload.path}.out`;
    try {
      const image = await processImage(upload.path, processedPath, {
        ...definition.rules,
        maxPixels: this.config.storage.maxImagePixels,
      });
      const provider = this.storage.active;
      const companyId = this.context.requireCompanyId('files.upload');
      const fileId = randomUUID();
      const key = `${definition.visibility.toLowerCase()}/${companyId}/${purpose.toLowerCase()}/${randomUUID()}.${image.ext}`;
      const uploader = this.uploader();

      // 3. The row, before the bytes: a crash after this is always findable.
      await this.files.transaction((tx) =>
        tx.file.create({
          data: {
            id: fileId,
            companyId,
            storageKey: key,
            storageProvider: provider.name,
            fileName: sanitiseFileName(upload.originalName, image.ext),
            mimeType: image.mimeType,
            sizeBytes: BigInt(image.sizeBytes),
            checksum: image.checksum,
            purpose,
            targetId,
            visibility: definition.visibility,
            width: image.width,
            height: image.height,
            status: 'UPLOADING',
            uploadedByType: uploader.type,
            uploadedById: uploader.id,
          },
        }),
      );

      // 4. The bytes, streamed.
      try {
        await provider.put(key, createReadStream(processedPath), {
          contentType: image.mimeType,
          contentLength: image.sizeBytes,
        });
      } catch (error) {
        this.logger.error(`Storing file ${fileId} failed: ${(error as Error).message}`);
        await provider.delete(key).catch(() => undefined);
        await this.discard(fileId, true);
        throw new StorageUnavailableError();
      }

      // 5. Attach, replacing whatever was there.
      let replaced: StoredFile | null;
      try {
        replaced = await this.files.transaction(async (tx, scopedCompanyId) => {
          const previous = await this.attach(tx, scopedCompanyId, definition, targetId, fileId);
          await tx.file.updateMany({
            where: { id: fileId, companyId: scopedCompanyId },
            data: { status: 'READY' },
          });
          return previous ? this.releaseIfUnused(tx, scopedCompanyId, previous) : null;
        });
      } catch (error) {
        await provider.delete(key).catch(() => undefined);
        await this.discard(fileId, true);
        throw error;
      }

      // 6. The old object, now that nothing points at it.
      if (replaced) await this.purge(replaced);

      await this.audit.record({
        action: replaced ? 'file.replaced' : 'file.uploaded',
        resourceType: 'file',
        resourceId: fileId,
        after: {
          purpose,
          targetId,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          width: image.width,
          height: image.height,
        },
        ...(replaced ? { before: { fileId: replaced.id } } : {}),
      });
      return this.get(fileId);
    } finally {
      await rm(processedPath, { force: true });
    }
  }

  /** Metadata, and a URL: the public one, or a signed one that expires in minutes. */
  async get(fileId: string) {
    const file = await this.files.transaction((tx, companyId) => this.find(tx, companyId, fileId));
    this.require(this.definition(file).read);
    return {
      ...this.view(file),
      url: await this.urlFor(file),
      urlExpiresAt:
        file.visibility === 'PRIVATE'
          ? new Date(Date.now() + this.config.storage.signedUrlTtlSeconds * 1000)
          : null,
    };
  }

  /**
   * Remove an image: detach it from its record, then delete it if nothing
   * else uses it (an image still referenced elsewhere is only detached).
   */
  async remove(fileId: string) {
    const { file, released } = await this.files.transaction(async (tx, companyId) => {
      const file = await this.find(tx, companyId, fileId);
      const definition = this.definition(file);
      this.require(definition.write);
      if (file.targetId) {
        const current = await definition.slot.current(tx, companyId, file.targetId);
        if (current === fileId) {
          const swapped = await definition.slot.swap(tx, companyId, file.targetId, fileId, null);
          if (!swapped)
            throw new ConflictError('The image changed while removing it. Reload and try again.');
        }
      }
      return { file, released: await this.releaseIfUnused(tx, companyId, file) };
    });
    if (released) await this.purge(released);
    await this.audit.record({
      action: 'file.removed',
      resourceType: 'file',
      resourceId: fileId,
      before: { purpose: file.purpose, targetId: file.targetId },
      after: { deleted: Boolean(released) },
    });
    return { removed: true, deleted: Boolean(released) };
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private async attach(
    tx: TenantTx,
    companyId: string,
    definition: PurposeDefinition,
    targetId: string,
    fileId: string,
  ): Promise<StoredFile | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await definition.slot.current(tx, companyId, targetId);
      if (current === undefined)
        throw new ResourceNotFoundError(definition.slot.resource, targetId);
      if (await definition.slot.swap(tx, companyId, targetId, current, fileId)) {
        return current
          ? tx.file.findFirst({ where: { id: current, companyId, deletedAt: null } })
          : null;
      }
    }
    throw new ConflictError('The image was changed at the same time. Try again.');
  }

  /** Soft-delete a file nothing points at any more; returns it for purging. */
  private async releaseIfUnused(
    tx: TenantTx,
    companyId: string,
    file: StoredFile,
  ): Promise<StoredFile | null> {
    if (await isReferenced(tx, companyId, file.id)) return null;
    await tx.file.updateMany({
      where: { id: file.id, companyId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return file;
  }

  /** Remove the stored object of a deleted file. A failure is retried by the cleanup sweep. */
  private async purge(file: StoredFile) {
    const provider = this.storage.forName(file.storageProvider);
    if (!provider) return;
    try {
      await provider.delete(file.storageKey);
      await this.files.transaction((tx, companyId) =>
        tx.file.updateMany({ where: { id: file.id, companyId }, data: { purgedAt: new Date() } }),
      );
    } catch (error) {
      this.logger.warn(
        `Could not delete the object of file ${file.id} yet: ${(error as Error).message}`,
      );
    }
  }

  /** A failed upload's row: deleted, and (when its object is known gone) purged. */
  private async discard(fileId: string, objectGone: boolean) {
    await this.files
      .transaction((tx, companyId) =>
        tx.file.updateMany({
          where: { id: fileId, companyId },
          data: { deletedAt: new Date(), ...(objectGone ? { purgedAt: new Date() } : {}) },
        }),
      )
      .catch((error: Error) =>
        this.logger.error(`Could not discard file ${fileId}: ${error.message}`),
      );
  }

  private async find(tx: TenantTx, companyId: string, fileId: string): Promise<StoredFile> {
    const file = await tx.file.findFirst({
      where: { id: fileId, companyId, deletedAt: null, status: 'READY' },
    });
    if (!file || !isFilePurpose(file.purpose)) throw new ResourceNotFoundError('File', fileId);
    return file;
  }

  private definition(file: StoredFile): PurposeDefinition {
    return PURPOSES[file.purpose as FilePurpose];
  }

  private require(permission: string) {
    if (!this.context.hasPermission(permission)) throw new PermissionDeniedError([permission]);
  }

  private async urlFor(file: StoredFile): Promise<string> {
    if (file.visibility === 'PUBLIC') return publicFileUrl(this.config, file.id);
    const provider = this.storage.forName(file.storageProvider);
    if (!provider) throw new StorageUnavailableError();
    return provider.signedUrl(file.storageKey, {
      expiresInSeconds: this.config.storage.signedUrlTtlSeconds,
      contentType: file.mimeType,
      fileName: file.fileName,
    });
  }

  private view(file: StoredFile) {
    return {
      id: file.id,
      purpose: file.purpose,
      targetId: file.targetId,
      visibility: file.visibility,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: Number(file.sizeBytes),
      width: file.width,
      height: file.height,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    };
  }

  private uploader(): { type: ActorType; id: string | null; label: string } {
    const actor = this.context.requireActor();
    switch (actor.kind) {
      case 'COMPANY_USER':
        return {
          type: 'COMPANY_USER',
          id: this.context.membership()?.companyUserId ?? null,
          label: actorLabel(actor),
        };
      case 'PLATFORM_USER':
        return { type: 'PLATFORM_USER', id: actor.platformUserId, label: actorLabel(actor) };
      default:
        return { type: 'SYSTEM', id: null, label: actorLabel(actor) };
    }
  }
}

/** Where a public image is served: through the API, which may redirect to a CDN. */
export function publicFileUrl(config: AppConfig, fileId: string): string {
  const { apiPublicUrl, apiPrefix } = config.storage;
  return `${apiPublicUrl}/${apiPrefix}/v1/public/files/${fileId}`;
}
