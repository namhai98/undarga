'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useSession } from '@/features/auth';
import { useOnboardingStatus } from '../api/use-onboarding';

/**
 * Pages that must stay reachable mid-onboarding: the wizard itself, and the
 * two screens for choosing (or lacking) a company — a member of two companies
 * whose active one is unfinished must still be able to switch to the other.
 */
const EXEMPT = ['/onboarding', '/select-company', '/no-company'];

/**
 * Sends a member who can finish onboarding back to it.
 *
 * ---------------------------------------------------------------------------
 * GUIDANCE, NOT A BOUNDARY
 * ---------------------------------------------------------------------------
 *
 * The API refuses nothing because onboarding is unfinished, and this renders
 * the page regardless while the status loads — it only redirects once the
 * answer is known. Only members with `canManage` are sent: a receptionist
 * invited into a company still being set up cannot finish the wizard, so
 * sending them to it would trap them.
 *
 * The platform console is a separate route group with its own session and
 * never mounts this.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const { status, activeCompanyId } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  const onboarding = useOnboardingStatus(
    activeCompanyId,
    status === 'authenticated' && Boolean(activeCompanyId),
  );
  const data = onboarding.data;
  const unfinished =
    data !== undefined &&
    data.company !== null &&
    data.company.id === activeCompanyId &&
    data.status !== 'COMPLETED' &&
    data.canManage;

  useEffect(() => {
    if (!unfinished) return;
    if (EXEMPT.some((path) => pathname === path || pathname.startsWith(`${path}/`))) return;
    router.replace('/onboarding');
  }, [unfinished, pathname, router]);

  return <>{children}</>;
}
