import { Injectable } from '@nestjs/common';
import { PlatformPrismaService } from '../database/platform-prisma.service';

/**
 * The one cross-tenant read the public image route needs: a file by id,
 * ONLY if it is public, fully stored and not deleted. A public booking page
 * has no company context to scope by — the file id is the address, and only
 * files deliberately marked PUBLIC (booking-page images) can be found here.
 */
@Injectable()
export class PublicFilesRepository {
  constructor(private readonly platformDb: PlatformPrismaService) {}

  findPublic(fileId: string) {
    return this.platformDb.file.findFirst({
      where: { id: fileId, visibility: 'PUBLIC', status: 'READY', deletedAt: null },
      select: {
        storageKey: true,
        storageProvider: true,
        mimeType: true,
        checksum: true,
        sizeBytes: true,
      },
    });
  }
}
