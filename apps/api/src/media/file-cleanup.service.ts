import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AppConfig } from '../config';
import { PlatformPrismaService } from '../database/platform-prisma.service';
import { StorageService } from './storage/storage.service';

/**
 * Keeps the `file` table and storage in step.
 *
 *   1. UPLOADING rows older than the grace period: the upload died between
 *      writing the row and attaching it. Deleted (with any partial object).
 *   2. READY rows that nothing references, older than the grace period — e.g.
 *      a record that pointed at it was hard-deleted. Deleted. A file still
 *      referenced anywhere (branding, staff, branch, service, customer,
 *      invoice) is never touched.
 *   3. Deleted rows whose object is still stored: the object is removed and
 *      the row marked purged. A storage outage just means "next time".
 *
 * Cross-tenant by nature (it cannot be told which company has garbage); every
 * write is keyed by row id. The row itself is kept, soft-deleted, as history.
 */
@Injectable()
export class FileCleanupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FileCleanupService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly platformDb: PlatformPrismaService,
    private readonly storage: StorageService,
    private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const { cleanupEnabled, cleanupIntervalMs } = this.config.storage;
    if (!cleanupEnabled || this.config.app.isTest) return;
    this.timer = setInterval(() => void this.tick(), cleanupIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(options: { now?: Date; limit?: number } = {}) {
    const now = options.now ?? new Date();
    const limit = options.limit ?? 200;
    const before = new Date(now.getTime() - this.config.storage.orphanGraceMinutes * 60_000);

    const abandoned = await this.platformDb.file.updateMany({
      where: { status: 'UPLOADING', deletedAt: null, createdAt: { lt: before } },
      data: { deletedAt: now },
    });

    const unreferenced = await this.platformDb.$queryRaw<Array<{ id: string }>>`
      SELECT f.id FROM file f
       WHERE f.status = 'READY' AND f.deleted_at IS NULL AND f.created_at < ${before}
         AND NOT EXISTS (SELECT 1 FROM company_branding b WHERE b.company_id = f.company_id
                          AND f.id IN (b.logo_file_id, b.favicon_file_id, b.email_header_file_id))
         AND NOT EXISTS (SELECT 1 FROM employee_profile p WHERE p.company_id = f.company_id AND p.avatar_file_id = f.id)
         AND NOT EXISTS (SELECT 1 FROM branch r WHERE r.company_id = f.company_id AND r.image_file_id = f.id)
         AND NOT EXISTS (SELECT 1 FROM service s WHERE s.company_id = f.company_id AND s.image_file_id = f.id)
         AND NOT EXISTS (SELECT 1 FROM company_customer c WHERE c.company_id = f.company_id AND c.photo_file_id = f.id)
         AND NOT EXISTS (SELECT 1 FROM invoice i WHERE i.company_id = f.company_id AND i.pdf_file_id = f.id)
       LIMIT ${limit}`;
    if (unreferenced.length) {
      await this.platformDb.file.updateMany({
        where: { id: { in: unreferenced.map((r) => r.id) }, deletedAt: null },
        data: { deletedAt: now },
      });
    }

    const toPurge = await this.platformDb.file.findMany({
      where: { deletedAt: { not: null }, purgedAt: null },
      select: { id: true, storageKey: true, storageProvider: true },
      take: limit,
    });
    let purged = 0;
    let failed = 0;
    for (const file of toPurge) {
      const provider = this.storage.forName(file.storageProvider);
      if (!provider) continue; // that backend is not configured here; leave it for one that is
      try {
        await provider.delete(file.storageKey);
        await this.platformDb.file.updateMany({
          where: { id: file.id },
          data: { purgedAt: new Date() },
        });
        purged += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(`Could not purge file ${file.id}: ${(error as Error).message}`);
      }
    }

    const result = {
      abandoned: abandoned.count,
      unreferenced: unreferenced.length,
      purged,
      failed,
    };
    if (result.abandoned || result.unreferenced || purged || failed) {
      this.logger.log(`File cleanup: ${JSON.stringify(result)}`);
    }
    return result;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.sweep();
    } catch (error) {
      this.logger.error(`File cleanup failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
