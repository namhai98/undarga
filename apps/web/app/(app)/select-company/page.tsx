'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CompanySwitcher, useSession } from '@/features/auth';
import { useT } from '@/lib/i18n';

/**
 * Choose which company to work in.
 *
 * Reached after signing in with more than one membership, and from the
 * dashboard. A user with one company never sees it — they are sent straight
 * through, because a picker offering a single option is furniture.
 */
export default function SelectCompanyPage() {
  const t = useT();
  const router = useRouter();
  const { memberships, isLoadingCompany } = useSession();

  useEffect(() => {
    if (isLoadingCompany) return;
    if (memberships.length === 0) router.replace('/no-company');
    if (memberships.length === 1) router.replace('/dashboard');
  }, [memberships.length, isLoadingCompany, router]);

  if (isLoadingCompany || memberships.length <= 1) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only">{t('Loading your companies…')}</span>
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-md gap-6">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold">{t('Choose a company')}</h1>
        <p className="text-muted-foreground text-sm">
          {t('You belong to {length}. Everything you do applies to the one you pick.', {
            length: memberships.length,
          })}
        </p>
      </div>

      <CompanySwitcher />

      <Link
        href="/onboarding?new=1"
        className={`${buttonVariants({ variant: 'outline', size: 'sm' })} w-fit`}
      >
        {t('Create another company')}
      </Link>
    </div>
  );
}
