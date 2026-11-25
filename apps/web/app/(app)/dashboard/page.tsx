'use client';

import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { buttonVariants } from '@/components/ui/button';
import { DashboardSummary } from '@/features/analytics';
import { useSession } from '@/features/auth';
import { useT } from '@/lib/i18n';

/**
 * Where a signed-in user lands.
 *
 * The business figures come first, because they are what somebody opens this
 * screen for in the morning. The access card below them stays: it is still the
 * fastest way to spot a tenant-resolution bug by eye, and it proves the session
 * resolved to the company the header claims.
 */
export default function DashboardPage() {
  const t = useT();
  const { user, activeCompany, memberships, permissions, isOwner, isLoadingCompany } = useSession();

  if (isLoadingCompany) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <span className="sr-only">{t('Loading your company…')}</span>
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold">
          {activeCompany ? activeCompany.companyName : t('Signed in')}
        </h1>
        <p className="text-muted-foreground text-sm">
          {user?.displayName} · {user?.email}
          {isOwner ? t(' · owner') : ''}
        </p>
      </div>

      <DashboardSummary />

      <Card>
        <CardHeader>
          <CardTitle>{t('Money and messages')}</CardTitle>
          <CardDescription>
            {t('Payments, gift cards, promotions and what went out.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link href="/payments" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('Payments')}
          </Link>
          <Link href="/gift-cards" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('Gift cards')}
          </Link>
          <Link href="/promotions" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('Promotions')}
          </Link>
          <Link href="/subscription" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('Subscription')}
          </Link>
          <Link href="/reports" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('Reports')}
          </Link>
          <Link href="/notifications" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            {t('Notifications')}
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('Your access')}</CardTitle>
          <CardDescription>
            {t('Resolved by the API for this company, not decided in the browser.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm">
            {permissions.size === 1
              ? t('1 permission in this company.')
              : t('{count} permissions in this company.', { count: permissions.size })}
          </p>
          <div className="flex flex-wrap gap-2">
            {permissions.has('member:read') ? (
              <Link href="/members" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                {t('Members and roles')}
              </Link>
            ) : null}
            <Link href="/account" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              {t('Your account')}
            </Link>
            {memberships.length > 1 ? (
              <Link
                href="/select-company"
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {t('Switch company')}
              </Link>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('Appointments')}</CardTitle>
          <CardDescription>
            {t('The appointment book: book, move, cancel and progress.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link href="/appointments" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('Open appointments')}
          </Link>
          <Link href="/appointments/new" className={buttonVariants({ size: 'sm' })}>
            {t('New appointment')}
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('Business settings')}</CardTitle>
          <CardDescription>
            {t('Company details, branches and their opening hours.')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/settings" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('Open settings')}
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('Staff')}</CardTitle>
          <CardDescription>
            {t('The people customers can book with, their services and working hours.')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/staff" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('Manage staff')}
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('Availability')}</CardTitle>
          <CardDescription>{t('Check what the engine says is bookable.')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/availability" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('Open availability')}
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('Booking page images')}</CardTitle>
          <CardDescription>{t('Your logo and branch pictures.')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            href="/booking-page-images"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {t('Manage images')}
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('Calendar integration')}</CardTitle>
          <CardDescription>
            {t('Put appointments in staff Google or Outlook calendars.')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/calendar" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('Connect calendars')}
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('Booking rules')}</CardTitle>
          <CardDescription>
            {t('Notice, how far ahead, cancellation and rescheduling deadlines.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link
            href="/booking-settings"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {t('Booking rules')}
          </Link>
          <Link href="/time-off" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            {t('Time off')}
          </Link>
          <Link href="/resources" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            {t('Rooms and equipment')}
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('Services')}</CardTitle>
          <CardDescription>{t('What customers can book, and how it is grouped.')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link href="/services" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('Manage services')}
          </Link>
          <Link
            href="/services/categories"
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            {t('Categories')}
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('Customers')}</CardTitle>
          <CardDescription>{t('The people you book work for.')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/customers" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('Manage customers')}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
