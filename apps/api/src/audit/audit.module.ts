import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../config';
import { DatabaseModule } from '../database/database.module';
import { AuditService } from './audit.service';

@Global()
@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
