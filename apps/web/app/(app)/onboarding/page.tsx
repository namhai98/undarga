import { OnboardingWizard } from '@/features/onboarding';

/**
 * Company onboarding.
 *
 * `?new=1` starts a new company even for someone who already has one — the
 * "Create another company" links send that. Read here, on the server, so the
 * client wizard needs no Suspense boundary for `useSearchParams`.
 */
export default async function OnboardingPage(props: PageProps<'/onboarding'>) {
  const searchParams = await props.searchParams;

  return <OnboardingWizard createNew={searchParams.new === '1'} />;
}
