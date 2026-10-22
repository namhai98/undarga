import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config';
import { LocalStorageProvider } from './local-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';
import type { StorageProvider, StorageProviderName } from './storage-provider';

/**
 * The configured storage backend (`STORAGE_DRIVER`), plus the other one when
 * it is also configured — a file remembers which backend holds it, so old
 * files stay readable (and deletable) after a switch.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  readonly local: LocalStorageProvider;
  readonly s3: S3StorageProvider | null;

  constructor(private readonly config: AppConfig) {
    const settings = config.storage;
    this.local = new LocalStorageProvider(settings.localRoot, {
      secret: settings.urlSigningSecret,
      downloadBaseUrl: `${settings.apiPublicUrl}/${settings.apiPrefix}/v1/files/signed`,
    });
    this.s3 = settings.s3 ? new S3StorageProvider(settings.s3) : null;
    if (settings.driver === 's3' && !this.s3) {
      // Env validation refuses this; belt and braces.
      throw new Error('STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY.');
    }
    this.logger.log(
      `File storage: ${settings.driver}${settings.driver === 's3' ? ` (bucket ${settings.s3!.bucket})` : ''}.`,
    );
  }

  /** Where new files go. */
  get active(): StorageProvider {
    return this.config.storage.driver === 's3' ? this.s3! : this.local;
  }

  /** The backend a stored file lives in, or null if it is not configured any more. */
  forName(name: string): StorageProvider | null {
    if (name === 'local') return this.local;
    if (name === 's3') return this.s3;
    return null;
  }

  static isProviderName(name: string): name is StorageProviderName {
    return name === 'local' || name === 's3';
  }
}
