'use client';

import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { buttonVariants } from '@/components/ui/button';
import { useSession } from '@/features/auth';

/**
 * Where a signed-in user lands.
 *
 * Deliberately thin: the product surface behind it — appointments, customers,
 * the calendar — is not built. What it does do is prove the session resolved
 * correctly, by showing the company and the permissions the SERVER says this
 * user holds. That is the useful thing to see at this stage, and it is the
 * fastest way to spot a tenant-resolution bug by eye.
 */
export default function DashboardPage() {
  const { user, activeCompany, memberships, permissions, isOwner, isLoadingCompany } = useSession();

  if (isLoadingCompany) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <span className="sr-only">Loading your company…</span>
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold">
          {activeCompany ? activeCompany.companyName : 'Signed in'}
        </h1>
        <p className="text-muted-foreground text-sm">
          {user?.displayName} · {user?.email}
          {isOwner ? ' · owner' : ''}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your access</CardTitle>
          <CardDescription>
            Resolved by the API for this company, not decided in the browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm">
            {permissions.size} permission{permissions.size === 1 ? '' : 's'} in this company.
          </p>
          {memberships.length > 1 ? (
            <div>
              <Link
                href="/select-company"
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                Switch company
              </Link>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Staff</CardTitle>
          <CardDescription>The people customers can book with.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/staff" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Manage staff
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Not built yet</CardTitle>
          <CardDescription>
            Members and roles, then the catalog, scheduling and booking.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
