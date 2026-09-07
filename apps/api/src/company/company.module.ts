import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CompanyController } from './company.controller';
import { CompanyService } from './company.service';

/**
 * The company a caller is inside: profile, settings, branding, lifecycle.
 *
 * Distinct from `platform/companies`, which CREATES companies and is reachable
 * only by platform operators. This one is administered from within, and the two
 * never share a route or a permission.
 *
 * TenancyModule and AuditModule are @Global, so RequestContextService,
 * TenantDirectoryService and AuditService need no import.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [CompanyController],
  providers: [CompanyService],
  exports: [CompanyService],
})
export class CompanyModule {}
