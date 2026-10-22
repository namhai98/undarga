import { Module } from '@nestjs/common';
import { ConfigModule } from '../config';
import { DatabaseModule } from '../database/database.module';
import { FileCleanupService } from './file-cleanup.service';
import { FilesController, PublicFilesController, SignedFilesController } from './files.controller';
import { FileRepository, FilesService } from './files.service';
import { PublicFilesRepository } from './public-files.repository';
import { StorageService } from './storage/storage.service';
import { SingleFileUploadInterceptor } from './upload.interceptor';

/**
 *     upload ─→ SingleFileUploadInterceptor (temp file) ─→ FilesService
 *                 ─→ image-processing (validate, re-encode) ─→ StorageService ─→ local | S3
 *                 ─→ attach to branding / branch / employee / service / customer
 *
 * Storage is behind StorageService only: nothing else touches a provider.
 * See docs/FILE-STORAGE.md.
 */
@Module({
  imports: [DatabaseModule, ConfigModule],
  controllers: [FilesController, PublicFilesController, SignedFilesController],
  providers: [
    StorageService,
    FilesService,
    FileRepository,
    PublicFilesRepository,
    FileCleanupService,
    SingleFileUploadInterceptor,
  ],
  exports: [FilesService, StorageService, FileCleanupService],
})
export class MediaModule {}
