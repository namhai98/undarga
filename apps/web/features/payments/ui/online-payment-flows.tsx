'use client';

import { useQueryClient } from '@tanstack/react-query';
import { CreditCard, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/services/api-error';
import {
  newIdempotencyKey,
  type OnlinePaymentBase,
  type PublicPaymentOffer,
} from '@/services/online-payments.service';
import {
  isOpen,
  useCancelOnlinePayment,
  useOnlinePayment,
  usePayInvoice,
  usePublicPayment,
  useRefundOnlinePayment,
  useSimulatePayment,
  useSimulatePublicPayment,
  useStartAppointmentPayment,
  useStartPublicPayment,
} from '../api/use-online-payments';
import { OnlineCheckout, money } from './online-checkout';
import { useT } from '@/lib/i18n';

/** What a start failure means to the person looking at the button. */
function startError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'PAYMENTS_UNAVAILABLE')
      return 'Online payments are not available right now.';
    if (error.code === 'PAYMENT_PROVIDER_ERROR') {
      return 'The payment provider did not respond. Please try again in a moment.';
    }
    return error.message;
  }
  return 'Could not start the payment. Please try again.';
}

/**
 * When a payment settles, everything that shows money may be stale — the
 * appointment's balance, the subscription, the invoice list. Refresh once,
 * on the transition, rather than polling all of it.
 */
function useOnSettled(status: OnlinePaymentBase['status'] | undefined, onSettled: () => void) {
  const previous = useRef(status);
  useEffect(() => {
    if (previous.current && isOpen(previous.current) && status && !isOpen(status)) onSettled();
    previous.current = status;
  }, [status, onSettled]);
}

// =============================================================================
// Staff: an appointment
// =============================================================================

/**
 * Collect an appointment's balance online: the customer scans the QR at the
 * desk, or is sent the link. Needs `payment:write`; the refund control needs
 * `payment:refund` and is shown only when the caller passes `canRefund`.
 */
export function AppointmentOnlinePayment({
  appointmentId,
  canRefund = false,
}: {
  appointmentId: string;
  canRefund?: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useStartAppointmentPayment();
  const payment = useOnlinePayment(id);
  const cancel = useCancelOnlinePayment();
  const simulate = useSimulatePayment();

  useOnSettled(payment.data?.status, () => void queryClient.invalidateQueries());

  const begin = async () => {
    setError(null);
    try {
      const started = await start.mutateAsync({
        appointmentId,
        idempotencyKey: newIdempotencyKey(),
      });
      setId(started.id);
    } catch (caught) {
      setError(startError(caught));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Online payment')}</CardTitle>
        <CardDescription>
          {t(
            'The customer pays with their bank app or card on the provider&rsquo;s page. The appointment is marked paid only when the provider confirms it.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{t('Could not start the payment')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {!id ? (
          <Button className="w-fit" disabled={start.isPending} onClick={() => void begin()}>
            {start.isPending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <CreditCard aria-hidden />
            )}
            {t('Collect online payment')}
          </Button>
        ) : payment.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : payment.error || !payment.data ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{t('Could not load the payment status.')}</AlertDescription>
          </Alert>
        ) : (
          <OnlineCheckout
            payment={payment.data}
            busy={start.isPending || cancel.isPending || simulate.isPending}
            onRetry={() => {
              setId(null);
              void begin();
            }}
            onCancel={() => void cancel.mutateAsync(payment.data!.id).catch(() => undefined)}
            onSimulate={(outcome) =>
              void simulate.mutateAsync({ id: payment.data!.id, outcome }).catch(() => undefined)
            }
            successMessage="The appointment has been updated."
          >
            {canRefund &&
            payment.data.status === 'SUCCEEDED' &&
            payment.data.refundedMinor !== payment.data.amountMinor ? (
              <RefundForm paymentId={payment.data.id} payment={payment.data} />
            ) : null}
          </OnlineCheckout>
        )}
      </CardContent>
    </Card>
  );
}

/** Full refund through the provider, with a reason and a confirmation step. */
function RefundForm({ paymentId, payment }: { paymentId: string; payment: OnlinePaymentBase }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refund = useRefundOnlinePayment();

  if (!confirming) {
    return (
      <Button variant="outline" size="sm" className="w-fit" onClick={() => setConfirming(true)}>
        {t('Refund')}
      </Button>
    );
  }

  return (
    <div className="border-border/60 grid gap-3 rounded-lg border p-3">
      <p className="text-sm font-medium">
        {t('Refund')} {money(payment.amountMinor, payment.currencyCode)} {t('to the payer?')}
      </p>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor="refund-reason">{t('Reason')}</Label>
        <Input
          id="refund-reason"
          value={reason}
          maxLength={512}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={reason.trim().length < 3 || refund.isPending}
          onClick={() => {
            setError(null);
            refund
              .mutateAsync({ id: paymentId, reason: reason.trim() })
              .catch((caught: unknown) => {
                setError(
                  caught instanceof ApiError ? caught.message : t('The refund did not go through.'),
                );
              });
          }}
        >
          {refund.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t('Confirm refund')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          {t('Keep the payment')}
        </Button>
      </div>
    </div>
  );
}

// =============================================================================
// Owner: a subscription invoice
// =============================================================================

export function InvoiceOnlinePayment({
  invoiceId,
  invoiceNumber,
  amountMinor,
  currencyCode,
}: {
  invoiceId: string;
  invoiceNumber: string;
  amountMinor: string;
  currencyCode: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pay = usePayInvoice();
  const payment = useOnlinePayment(id);
  const cancel = useCancelOnlinePayment();
  const simulate = useSimulatePayment();

  useOnSettled(payment.data?.status, () => void queryClient.invalidateQueries());

  const begin = async () => {
    setError(null);
    try {
      const started = await pay.mutateAsync({ invoiceId, idempotencyKey: newIdempotencyKey() });
      setId(started.id);
    } catch (caught) {
      setError(startError(caught));
    }
  };

  return (
    <div className="grid gap-4">
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('Could not start the payment')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!id ? (
        <Button className="w-fit" disabled={pay.isPending} onClick={() => void begin()}>
          {pay.isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <CreditCard aria-hidden />
          )}
          {t('Pay')} {invoiceNumber} — {money(amountMinor, currencyCode)}
        </Button>
      ) : payment.data ? (
        <div className="border-border/60 rounded-lg border p-4">
          <OnlineCheckout
            payment={payment.data}
            busy={pay.isPending || cancel.isPending || simulate.isPending}
            onRetry={() => {
              setId(null);
              void begin();
            }}
            onCancel={() => void cancel.mutateAsync(payment.data!.id).catch(() => undefined)}
            onSimulate={(outcome) =>
              void simulate.mutateAsync({ id: payment.data!.id, outcome }).catch(() => undefined)
            }
            successMessage="The invoice is paid and your subscription is up to date."
          />
        </div>
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
    </div>
  );
}

// =============================================================================
// Public: the booker, on the confirmation page
// =============================================================================

export function PublicBookingPayment({ slug, offer }: { slug: string; offer: PublicPaymentOffer }) {
  const t = useT();
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useStartPublicPayment(slug, offer.token);
  const payment = usePublicPayment(slug, id, offer.token);
  const simulate = useSimulatePublicPayment(slug, offer.token);

  const begin = async () => {
    setError(null);
    try {
      const started = await start.mutateAsync(newIdempotencyKey());
      setId(started.id);
    } catch (caught) {
      setError(startError(caught));
    }
  };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <p className="text-sm font-medium">
          {offer.purpose === 'DEPOSIT' ? t('Pay the deposit now') : t('Pay now')}
        </p>
        <p className="text-muted-foreground text-xs">
          {t(
            'Optional — your booking is confirmed either way. You pay on the provider&rsquo;s secure page or with your bank app; we never see your card details.',
          )}
        </p>
      </div>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('Could not start the payment')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!id ? (
        <Button className="w-fit" disabled={start.isPending} onClick={() => void begin()}>
          {start.isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <CreditCard aria-hidden />
          )}
          {t('Pay')} {money(offer.amountMinor, offer.currencyCode)}
        </Button>
      ) : payment.data ? (
        <OnlineCheckout
          payment={payment.data}
          busy={start.isPending || simulate.isPending}
          onRetry={() => {
            setId(null);
            void begin();
          }}
          onSimulate={(outcome) =>
            void simulate.mutateAsync({ id: payment.data!.id, outcome }).catch(() => undefined)
          }
          successMessage="Your payment was received. See you soon."
        />
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
    </div>
  );
}
