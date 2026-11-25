'use client';

import { CheckCircle2 } from 'lucide-react';
import { PriceBreakdown } from '@/components/price-breakdown';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PublicBookingPayment } from '@/features/payments';
import type { PublicBookingConfirmation } from '@/services/public-booking.service';
import { formatDay, wallTime } from '../model/booking-flow';
import { price } from './steps';
import { useT } from '@/lib/i18n';

/**
 * The end of the flow: what was booked, as the server recorded it. Everything
 * shown comes from the booking response — not from what the page believed it
 * was submitting.
 */
export function BookingConfirmation(props: {
  confirmation: PublicBookingConfirmation;
  /** The company's public slug, for paying online. */
  slug: string;
  locale?: string;
  onBookAnother: () => void;
}) {
  const t = useT();
  const c = props.confirmation;
  const date = c.startsAt.slice(0, 10);
  const pending = c.status === 'PENDING';

  return (
    <Card role="status" aria-live="polite">
      <CardHeader className="grid justify-items-center gap-2 text-center">
        <CheckCircle2 aria-hidden className="text-primary size-12" />
        <CardTitle className="text-xl">
          {pending ? t('Request received') : t('You’re booked')}, {c.customer.firstName}
        </CardTitle>
        <p className="text-muted-foreground text-sm">
          {pending
            ? t('The business will confirm your appointment shortly.')
            : t('Your appointment is confirmed.')}
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Row label={t('Service')} value={`${c.service.name} (${c.service.durationMin} min)`} />
          <Row
            label={t('When')}
            value={`${formatDay(date, props.locale, true)}, ${wallTime(c.startsAt)}–${wallTime(c.endsAt)}`}
          />
          <Row label={t('With')} value={c.employee?.name ?? 'Our team'} />
          <Row
            label={t('Where')}
            value={[c.branch.name, c.branch.address].filter(Boolean).join(' — ')}
          />
          {c.price.discountMinor === '0' ? (
            <Row label={t('Price')} value={price(c.price.amountMinor, c.price.currencyCode)} />
          ) : null}
          <Row label={t('Reference')} value={c.appointmentNumber} mono />
        </dl>
        {c.price.discountMinor !== '0' ? (
          <PriceBreakdown
            originalMinor={c.price.originalMinor}
            discountMinor={c.price.discountMinor}
            finalMinor={c.price.amountMinor}
            currencyCode={c.price.currencyCode}
            discountLabel={c.promotion?.code ?? c.promotion?.name ?? null}
          />
        ) : null}
        {c.payment ? (
          <div className="border-border/60 border-t pt-4">
            <PublicBookingPayment slug={props.slug} offer={c.payment} />
          </div>
        ) : null}
        <p className="text-muted-foreground text-xs">
          {t('Times are in')} {c.timezone}.
          {c.branch.phone
            ? t(' To change or cancel, call {phone} and quote your reference.', {
                phone: c.branch.phone,
              })
            : t(' Quote your reference if you need to change or cancel.')}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="w-full sm:w-fit" onClick={props.onBookAnother}>
            {t('Book another appointment')}
          </Button>
          {/* Sign-in is by a code to the email on the booking. */}
          <Link
            href={`/portal/${props.slug}`}
            className={`${buttonVariants({ variant: 'ghost' })} w-full sm:w-fit`}
          >
            {t('Manage my bookings')}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function Row(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs">{props.label}</dt>
      <dd className={props.mono ? 'font-mono' : 'font-medium'}>{props.value}</dd>
    </div>
  );
}
