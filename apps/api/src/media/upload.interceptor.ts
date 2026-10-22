import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import multer from 'multer';
import { finalize, from, switchMap, type Observable } from 'rxjs';
import { FileTooLargeError, ValidationFailedError } from '../common/errors';
import { AppConfig } from '../config';

export const UPLOAD_TMP_DIR = join(tmpdir(), 'undarga-uploads');

export interface UploadedTempFile {
  /** Where multer wrote it. Deleted when the request ends, whatever happens. */
  path: string;
  /** As the client sent them: display only, never trusted. */
  originalName: string;
  claimedMime: string;
  size: number;
}

export type RequestWithUpload = Request & { file?: multer.File; uploaded?: UploadedTempFile };

/**
 * Reads ONE multipart file (field `file`) to a temp file, streamed: the bytes
 * go to disk as they arrive, and the request is cut off the moment it passes
 * the size limit.
 *
 * It runs after the guards — authentication, tenant and permission checks
 * all happen before a single byte of the body is read. The temp file is named
 * by the server (a UUID, no extension), so nothing the client sent becomes a
 * path, and it is removed when the response finishes, success or not.
 */
@Injectable()
export class SingleFileUploadInterceptor implements NestInterceptor {
  private readonly upload: ReturnType<multer.Instance['single']>;
  readonly maxBytes: number;

  constructor(config: AppConfig) {
    this.maxBytes = config.storage.maxImageBytes;
    mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
    this.upload = multer({
      storage: multer.diskStorage({
        destination: UPLOAD_TMP_DIR,
        filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
      }),
      limits: {
        fileSize: this.maxBytes,
        files: 1,
        fields: 4,
        fieldSize: 256,
        fieldNameSize: 32,
        parts: 6,
      },
    }).single('file');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithUpload>();
    const response = http.getResponse<Response>();

    const parsed = new Promise<void>((resolve, reject) => {
      this.upload(request, response, (error?: unknown) => {
        if (!error) return resolve();
        if (error instanceof multer.MulterError) {
          if (error.code === 'LIMIT_FILE_SIZE') return reject(new FileTooLargeError(this.maxBytes));
          return reject(
            new ValidationFailedError([
              { path: [error.field ?? 'file'], message: 'Send one file in the `file` field.' },
            ]),
          );
        }
        reject(
          new ValidationFailedError([{ path: ['file'], message: 'The upload could not be read.' }]),
        );
      });
    }).then(() => {
      const file = request.file;
      if (!file) {
        throw new ValidationFailedError([
          { path: ['file'], message: 'Attach the image in the `file` field.' },
        ]);
      }
      request.uploaded = {
        path: file.path,
        originalName: file.originalname ?? '',
        claimedMime: file.mimetype ?? '',
        size: file.size,
      };
    });

    return from(parsed).pipe(
      switchMap(() => next.handle()),
      finalize(() => {
        const path = request.file?.path;
        if (path) void rm(path, { force: true });
      }),
    );
  }
}
