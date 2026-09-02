import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PlatformIdentityService } from './platform-identity.service';

/**
 * Platform realm.
 *
 * Global because JwtAuthGuard (registered app-wide) needs PlatformIdentityService
 * to resolve operator permissions. Only the identity piece lives here for now —
 * operator-facing endpoints are a separate phase.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [PlatformIdentityService],
  exports: [PlatformIdentityService],
})
export class PlatformModule {}
