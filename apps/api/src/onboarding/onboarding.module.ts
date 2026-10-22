import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

/**
 * Company onboarding. Everything it depends on — provisioning (PlatformModule),
 * the directory and membership (TenancyModule), entitlements, audit and the
 * tenant connection — is provided by @Global modules.
 */
@Module({
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
