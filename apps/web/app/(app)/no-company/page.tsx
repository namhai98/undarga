'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
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
 * Left as an explanation rather than a call to action because there is no
 * self-serve signup: a company is provisioned by a platform operator, so the
 * genuine next step is to ask somebody, not to click something.
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
        <CardContent className="text-muted-foreground grid gap-2 text-sm">
          <p>
            Companies are set up by the platform team, not self-serve. If you were expecting access,
            ask whoever invited you to send a new invitation link.
          </p>
          <p>If you have one already, opening it will bring you straight here.</p>
        </CardContent>
      </Card>
    </div>
  );
}
