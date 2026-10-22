'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/features/auth';

/**
 * Signed in, but a member of nothing.
 *
 * A real state, not an error. An account exists independently of any company:
 * someone can be removed from the last company they belonged to, or a
 * provisioned owner's account can exist before the invitation is accepted. The
 * API is quite happy to issue them a token — there is simply no tenant to enter.
 *
 * Two genuine next steps: create a company through onboarding (the caller
 * becomes its owner), or wait for an invitation to someone else's.
 */
export default function NoCompanyPage() {
  const router = useRouter();
  const { memberships, isLoadingCompany, user } = useSession();

  useEffect(() => {
    // They may have just accepted an invitation in another tab.
    if (!isLoadingCompany && memberships.length > 0) {
      router.replace(memberships.length === 1 ? '/dashboard' : '/select-company');
    }
  }, [memberships.length, isLoadingCompany, router]);

  if (isLoadingCompany) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only">Loading your companies…</span>
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>You are not in a company yet</CardTitle>
          <CardDescription>
            Your account works — {user?.email} — but it is not attached to one.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <div className="grid gap-2">
            <p className="font-medium">Starting your own business?</p>
            <p className="text-muted-foreground">
              Set up your company in a few steps. You will be its owner, and your free trial starts
              straight away.
            </p>
            <Link href="/onboarding" className={`${buttonVariants({ size: 'sm' })} w-fit`}>
              Create your company
            </Link>
          </div>
          <div className="text-muted-foreground grid gap-2 border-t pt-4">
            <p>
              Joining someone else&rsquo;s company? Ask whoever invited you to send a new invitation
              link. Opening it will bring you straight here.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
