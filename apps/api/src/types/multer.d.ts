/**
 * The part of multer's API the upload interceptor uses. multer ships no
 * types and @types/multer is not installed; this is deliberately narrow.
 */
declare module 'multer' {
  import type { Request, RequestHandler } from 'express';

  namespace multer {
    interface File {
      fieldname: string;
      originalname: string;
      encoding: string;
      mimetype: string;
      size: number;
      destination: string;
      filename: string;
      path: string;
    }

    interface StorageEngine {
      _handleFile(
        req: Request,
        file: File,
        callback: (error?: unknown, info?: Partial<File>) => void,
      ): void;
      _removeFile(req: Request, file: File, callback: (error: Error | null) => void): void;
    }

    interface DiskStorageOptions {
      destination:
        | string
        | ((
            req: Request,
            file: File,
            cb: (error: Error | null, destination: string) => void,
          ) => void);
      filename?: (
        req: Request,
        file: File,
        cb: (error: Error | null, filename: string) => void,
      ) => void;
    }

    interface Options {
      storage?: StorageEngine;
      limits?: {
        fileSize?: number;
        files?: number;
        fields?: number;
        fieldSize?: number;
        fieldNameSize?: number;
        parts?: number;
      };
      fileFilter?: (
        req: Request,
        file: File,
        cb: (error: Error | null, accept?: boolean) => void,
      ) => void;
    }

    interface Instance {
      single(field: string): RequestHandler;
    }

    class MulterError extends Error {
      code: string;
      field?: string;
    }

    function diskStorage(options: DiskStorageOptions): StorageEngine;
  }

  function multer(options?: multer.Options): multer.Instance;
  export = multer;
}
