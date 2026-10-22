import { Controller, Delete, Get, Param, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import {
  ResourceNotFoundError,
  StorageUnavailableError,
  ValidationFailedError,
} from '../common/errors';
import { ZodValidationPipe } from '../common/pipes';
import { AppConfig } from '../config';
import { RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import { FILE_PURPOSES } from './file-purposes';
import { FilesService } from './files.service';
import { PublicFilesRepository } from './public-files.repository';
import { contentDisposition, StorageObjectMissingError } from './storage/storage-provider';
import { StorageService } from './storage/storage.service';
import { SingleFileUploadInterceptor, type RequestWithUpload } from './upload.interceptor';

const uuidParam = new ZodValidationPipe(z.string().uuid());
const C = COMPANY_PERMISSIONS;
/** Any of these lets the request in; the purpose's own permission is checked in the service. */
const WRITERS = [
  C.BRANDING_WRITE,
  C.BRANCH_WRITE,
  C.EMPLOYEE_WRITE,
  C.SERVICE_WRITE,
  C.CUSTOMER_WRITE,
] as const;
const READERS = [
  C.COMPANY_READ,
  C.BRANCH_READ,
  C.EMPLOYEE_READ,
  C.SERVICE_READ,
  C.CUSTOMER_READ,
] as const;

const uploadFieldsSchema = z
  .object({
    purpose: z.enum(FILE_PURPOSES),
    targetId: z.string().uuid().optional(),
  })
  .strict();

/** Headers every served file gets: it is an image, nothing else, and never a page. */
function safeHeaders(res: Response, contentType: string) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

/**
 * Images for company records: logos, branch and service pictures, staff and
 * customer photos. Upload attaches in the same request (see FilesService).
 */
@ApiTags('files')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/files', version: '1' })
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @RequirePermission(...WRITERS)
  @RequiresWrite()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(SingleFileUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'purpose'],
      properties: {
        file: { type: 'string', format: 'binary' },
        purpose: { type: 'string', enum: [...FILE_PURPOSES] },
        targetId: { type: 'string', format: 'uuid', description: 'Not for COMPANY_LOGO.' },
      },
    },
  })
  @ApiOperation({
    summary: 'Upload an image and attach it to its record',
    description:
      'JPEG, PNG or WebP, judged by content. Validated, re-encoded (metadata such as GPS removed), ' +
      'stored, and attached — replacing (and deleting) the previous image. Needs the purpose’s ' +
      'write permission: branding, branch, employee, service or customer.',
  })
  @ApiResponse({ status: 413, description: 'FILE_TOO_LARGE' })
  @ApiResponse({ status: 415, description: 'FILE_TYPE_NOT_ALLOWED' })
  @ApiResponse({
    status: 422,
    description: 'FILE_INVALID — not a valid image, or dimensions out of range.',
  })
  @ApiResponse({ status: 503, description: 'STORAGE_UNAVAILABLE — nothing was saved.' })
  async upload(@Req() request: RequestWithUpload) {
    const fields = uploadFieldsSchema.safeParse(request.body ?? {});
    if (!fields.success) throw new ValidationFailedError(fields.error.issues);
    return this.files.upload(fields.data, request.uploaded!);
  }

  @Get(':fileId')
  @RequirePermission(...READERS)
  @ApiOperation({
    summary: 'File metadata and a URL',
    description:
      'Public images get their public URL; private files a signed URL valid for minutes.',
  })
  async get(@Param('fileId', uuidParam) fileId: string) {
    return this.files.get(fileId);
  }

  @Delete(':fileId')
  @RequirePermission(...WRITERS)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Remove an image',
    description: 'Detaches it from its record and deletes it, unless something else still uses it.',
  })
  async remove(@Param('fileId', uuidParam) fileId: string) {
    return this.files.remove(fileId);
  }
}

/**
 * Booking-page images, for anyone: only files deliberately PUBLIC. Streamed
 * from storage (or redirected to a CDN), never buffered; immutable, because a
 * new image is a new id.
 */
@ApiTags('files')
@Controller({ path: 'public/files', version: '1' })
@Public()
export class PublicFilesController {
  constructor(
    private readonly repository: PublicFilesRepository,
    private readonly storage: StorageService,
    private readonly config: AppConfig,
  ) {}

  @Get(':fileId')
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({ summary: 'A public image (logo, branch, staff or service picture)' })
  async serve(
    @Param('fileId', uuidParam) fileId: string,
    @Req() req: RequestWithUpload,
    @Res() res: Response,
  ) {
    const file = await this.repository.findPublic(fileId);
    if (!file) throw new ResourceNotFoundError('File', fileId);
    const etag = `"${file.checksum}"`;
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    const cdn = this.config.storage.publicBaseUrl;
    if (cdn && file.storageProvider === 's3') {
      res.redirect(302, `${cdn}/${file.storageKey}`);
      return;
    }
    await stream(res, this.storage, file.storageProvider, file.storageKey, file.mimeType, fileId);
  }
}

/**
 * Local-driver signed downloads (S3 signs its own URLs). The token is the
 * authorisation: HMAC over key, type, name and expiry. Never logged.
 */
@ApiTags('files')
@Controller({ path: 'files/signed', version: '1' })
@Public()
export class SignedFilesController {
  constructor(private readonly storage: StorageService) {}

  @Get(':token')
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiOperation({ summary: 'Download a private file with a signed, expiring token' })
  async download(@Param('token') token: string, @Res() res: Response) {
    const grant = this.storage.local.verifyToken(token);
    if (!grant) throw new ResourceNotFoundError('File', 'signed');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', contentDisposition(grant.fileName));
    res.setHeader('Referrer-Policy', 'no-referrer');
    await stream(res, this.storage, 'local', grant.key, grant.contentType, 'signed');
  }
}

async function stream(
  res: Response,
  storage: StorageService,
  providerName: string,
  key: string,
  contentType: string,
  label: string,
) {
  const provider = storage.forName(providerName);
  if (!provider) throw new StorageUnavailableError();
  let object;
  try {
    object = await provider.get(key);
  } catch (error) {
    if (error instanceof StorageObjectMissingError) throw new ResourceNotFoundError('File', label);
    throw new StorageUnavailableError();
  }
  safeHeaders(res, contentType);
  if (object.contentLength !== null) res.setHeader('Content-Length', String(object.contentLength));
  object.body.on('error', () => res.destroy());
  object.body.pipe(res);
}
