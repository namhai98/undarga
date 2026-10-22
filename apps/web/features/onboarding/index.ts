/**
 * The onboarding feature's public surface: the wizard, the shell gate that
 * guides unfinished owners back to it, and the status hook.
 */
export {
  onboardingKeys,
  useOnboardingStatus,
  useCreateOnboardingCompany,
  useOnboardingSetup,
  useCompleteOnboarding,
} from './api/use-onboarding';

export { OnboardingWizard } from './ui/onboarding-wizard';
export { OnboardingGate } from './ui/onboarding-gate';
