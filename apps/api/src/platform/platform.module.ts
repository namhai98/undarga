import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CompanyProvisioningService } from './companies/company-provisioning.service';
import { PlatformCompaniesController } from './companies/platform-companies.controller';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformIdentityService } from './platform-identity.service';

/**
 * Platform realm.
 *
 * Global because JwtAuthGuard (registered app-wide) needs PlatformIdentityService
 * to resolve operator permissions.
 *
 * TenantDirectoryService and AuditService are not imported: both live in
 * @Global modules, so injecting them here creates no dependency edge and no
 * cycle — which matters, because TenancyModule sits downstream of this one.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [PlatformCompaniesController, PlatformAdminController],
  providers: [PlatformIdentityService, CompanyProvisioningService, PlatformAdminService],
  // CompanyProvisioningService is exported for self-serve onboarding, which
  // creates a company through the same transaction (docs/ONBOARDING.md).
  exports: [PlatformIdentityService, PlatformAdminService, CompanyProvisioningService],
})
export class PlatformModule {}
