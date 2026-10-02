'use client';

import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { buttonVariants } from '@/components/ui/button';
import { DashboardSummary } from '@/features/analytics';
import { useSession } from '@/features/auth';

/**
 * Where a signed-in user lands.
 *
 * The business figures come first, because they are what somebody opens this
 * screen for in the morning. The access card below them stays: it is still the
 * fastest way to spot a tenant-resolution bug by eye, and it proves the session
 * resolved to the company the header claims.
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

      <DashboardSummary />

      <Card>
        <CardHeader>
          <CardTitle>Money and messages</CardTitle>
          <CardDescription>Payments, gift cards, promotions and what went out.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link href="/payments" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Payments
          </Link>
          <Link href="/gift-cards" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Gift cards
          </Link>
          <Link href="/promotions" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Promotions
          </Link>
          <Link href="/subscription" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Subscription
          </Link>
          <Link href="/reports" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Reports
          </Link>
          <Link href="/notifications" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            Notifications
          </Link>
        </CardContent>
      </Card>

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
          <CardTitle>Appointments</CardTitle>
          <CardDescription>The appointment book: book, move, cancel and progress.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link href="/appointments" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Open appointments
          </Link>
          <Link href="/appointments/new" className={buttonVariants({ size: 'sm' })}>
            New appointment
          </Link>
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
          <CardTitle>Availability</CardTitle>
          <CardDescription>Check what the engine says is bookable.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/availability" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Open availability
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Services</CardTitle>
          <CardDescription>What customers can book, and how it is grouped.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link href="/services" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Manage services
          </Link>
          <Link
            href="/services/categories"
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            Categories
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Customers</CardTitle>
          <CardDescription>The people you book work for.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/customers" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Manage customers
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Not built yet</CardTitle>
          <CardDescription>Members and roles, then scheduling and booking.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
