'use client';

import { formatMoney } from '@undarga/shared';
import { CheckCircle2, ExternalLink, Loader2, RotateCcw, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { currencyFormat } from '@/lib/currency';
import type { OnlinePaymentBase, SimulatedOutcome } from '@/services/online-payments.service';
import { isOpen } from '../api/use-online-payments';

export const ONLINE_STATUS_LABEL: Record<OnlinePaymentBase['status'], string> = {
  PENDING: 'Waiting for payment',
  PROCESSING: 'Processing',
  SUCCEEDED: 'Paid',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};

export function onlineStatusTone(
  status: OnlinePaymentBase['status'],
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'SUCCEEDED') return 'default';
  if (status === 'FAILED') return 'destructive';
  if (status === 'PENDING' || status === 'PROCESSING') return 'secondary';
  return 'outline';
}

export function money(amountMinor: string, currencyCode: string): string {
  return formatMoney({ amountMinor, currencyCode }, currencyFormat(currencyCode));
}

/**
 * One online payment, whatever it is for.
 *
 * Shows what the payer needs — the amount, the QR or bank-app links, or a
 * hosted page — and what the SERVER says happened. "Paid" appears only when
 * the provider confirmed it; nothing the browser does can make it appear.
 * The provider's own hosted page or QR takes the payment details; no card
 * number is ever typed into this application.
 */
export function OnlineCheckout({
  payment,
  onRetry,
  onCancel,
  onSimulate,
  busy = false,
  successMessage = 'Payment received. Thank you.',
  children,
}: {
  payment: OnlinePaymentBase;
  onRetry?: () => void;
  onCancel?: () => void;
  /** Development only: offered when the provider is the local simulator. */
  onSimulate?: (outcome: SimulatedOutcome) => void;
  busy?: boolean;
  successMessage?: string;
  children?: ReactNode;
}) {
  const open = isOpen(payment.status);
  const checkout = payment.checkout;

  return (
    <div className="grid gap-4" aria-busy={open}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="grid gap-0.5">
          <p className="text-2xl font-semibold tabular-nums">
            {money(payment.amountMinor, payment.currencyCode)}
          </p>
          <p className="text-muted-foreground text-xs">
            {payment.currencyCode}
            {payment.reference ? ` · ${payment.reference}` : ''}
          </p>
        </div>
        <Badge variant={onlineStatusTone(payment.status)}>{ONLINE_STATUS_LABEL[payment.status]}</Badge>
      </div>

      {open ? (
        <>
          <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status" aria-live="polite">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {payment.status === 'PROCESSING'
              ? 'The payment is being processed. This page updates by itself.'
              : 'Waiting for the payment. This page updates by itself once the provider confirms it.'}
          </p>

          {checkout?.qrImage ? (
            // A provider-generated `data:` URL: nothing for next/image to optimise.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={checkout.qrImage}
              alt="QR code to scan with a banking app"
              className="border-border/60 mx-auto size-56 rounded-lg border bg-white p-2"
            />
          ) : null}

          {checkout?.deeplinks && checkout.deeplinks.length > 0 ? (
            <div className="grid gap-2">
              <p className="text-sm font-medium">Or open your bank app</p>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {checkout.deeplinks.map((link) => (
                  <li key={`${link.name}-${link.link}`}>
                    <a
                      href={link.link}
                      className={`${buttonVariants({ variant: 'outline', size: 'sm' })} w-full justify-start`}
                    >
                      {link.logo ? (
                        // Bank logos come from the provider's CDN, per invoice; a
                        // next/image remote pattern would have to allow every bank.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={link.logo} alt="" className="size-4" />
                      ) : null}
                      <span className="truncate">{link.name}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {checkout?.redirectUrl ? (
            <a
              href={checkout.redirectUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`${buttonVariants({ size: 'sm' })} w-fit`}
            >
              Open the payment page
              <ExternalLink aria-hidden className="size-4" />
            </a>
          ) : null}

          {checkout?.simulated && onSimulate ? (
            <div className="border-border/60 grid gap-2 rounded-lg border border-dashed p-3">
              <p className="text-muted-foreground text-xs">
                Development: this is the local payment simulator. Choose what the payer does — the
                result arrives through the real signed webhook.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={() => onSimulate('SUCCEEDED')}>
                  Simulate payment
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => onSimulate('FAILED')}>
                  Simulate decline
                </Button>
              </div>
            </div>
          ) : null}

          {onCancel && payment.status === 'PENDING' ? (
            <Button variant="ghost" size="sm" className="w-fit" disabled={busy} onClick={onCancel}>
              Cancel this payment
            </Button>
          ) : null}
        </>
      ) : null}

      {payment.status === 'SUCCEEDED' ? (
        <Alert role="status">
          <CheckCircle2 aria-hidden className="size-4" />
          <AlertTitle>Paid</AlertTitle>
          <AlertDescription>
            {successMessage}
            {payment.failureReason ? ` ${payment.failureReason}` : ''}
          </AlertDescription>
        </Alert>
      ) : null}

      {payment.status === 'FAILED' || payment.status === 'CANCELLED' ? (
        <Alert variant="destructive" role="alert">
          <XCircle aria-hidden className="size-4" />
          <AlertTitle>{payment.status === 'FAILED' ? 'The payment failed' : 'The payment was cancelled'}</AlertTitle>
          <AlertDescription className="grid gap-3">
            <p>{payment.failureReason ?? 'No money was taken.'}</p>
            {onRetry && payment.retryable ? (
              <Button size="sm" className="w-fit" disabled={busy} onClick={onRetry}>
                <RotateCcw aria-hidden className="size-4" />
                Try again
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {payment.status === 'REFUNDED' ? (
        <Alert role="status">
          <AlertTitle>Refunded</AlertTitle>
          <AlertDescription>
            {money(payment.refundedMinor, payment.currencyCode)} was returned to the payer.
          </AlertDescription>
        </Alert>
      ) : null}

      {children}
    </div>
  );
}
