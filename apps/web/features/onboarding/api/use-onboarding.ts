'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authService } from '@/services/auth.service';
import {
  onboardingService,
  type CreateOnboardingCompanyInput,
  type InitialServiceInput,
  type OnboardingSetupInput,
} from '@/services/onboarding.service';
import { tokenStore } from '@/services/token-store';

export const onboardingKeys = {
  all: ['onboarding'] as const,
  status: (companyId: string | null) => [...onboardingKeys.all, 'status', companyId] as const,
  slug: (slug: string) => [...onboardingKeys.all, 'slug', slug] as const,
};

/**
 * Onboarding status for the active company (or for "no company" when null).
 *
 * Keyed on the company so a company switch never shows the previous one's
 * state, and kept fresh for a minute: the shell reads it on every navigation.
 */
export function useOnboardingStatus(companyId: string | null, enabled = true) {
  return useQuery({
    queryKey: onboardingKeys.status(companyId),
    queryFn: ({ signal }) => onboardingService.status(companyId, signal),
    enabled,
    staleTime: 60_000,
  });
}

/** Live "is this identifier free?", for the company step. */
export function useSlugAvailability(slug: string) {
  return useQuery({
    queryKey: onboardingKeys.slug(slug),
    queryFn: ({ signal }) => onboardingService.slugAvailability(slug, signal),
    enabled: slug.length >= 3,
    staleTime: 30_000,
  });
}

/**
 * Create the company (steps 1-3), then make it the active company.
 *
 * The switch issues a new token pair for the new company — the same call the
 * company switcher makes — so step 4 runs in a session that belongs to it.
 * Unlike `useSwitchCompany` this does not navigate: the wizard carries on to
 * the services step. The cache is cleared for the same reason the switcher
 * clears it: nothing from the previous company may linger.
 */
export function useCreateOnboardingCompany() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateOnboardingCompanyInput) => {
      const created = await onboardingService.createCompany(input);
      const session = await authService.switchCompany(created.company.id);
      return { created, session };
    },
    onSuccess: async ({ session }) => {
      await queryClient.cancelQueries();
      queryClient.clear();
      tokenStore.set(session, 'company-switched');
    },
  });
}

export function useOnboardingSetup(companyId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: OnboardingSetupInput) => onboardingService.setup(companyId, input),
    // Name, currency and status may all have changed.
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

export function useCompleteOnboarding(companyId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (services: InitialServiceInput[]) => onboardingService.complete(companyId, services),
    onSuccess: (result) => {
      queryClient.setQueryData(onboardingKeys.status(companyId), (previous: unknown) =>
        previous && typeof previous === 'object'
          ? { ...previous, ...result.onboarding }
          : previous,
      );
      return queryClient.invalidateQueries();
    },
  });
}
