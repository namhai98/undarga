'use client';

import { decimalToMinorString, formatMoney, minorToDecimalString } from '@undarga/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { currencyFormat } from '@/lib/currency';
import { ApiError } from '@/services/api-error';
import type { Payment } from '@/services/billing.service';
import { useRefundPayment } from '../api/use-billing';
import { useT } from '@/lib/i18n';

/**
 * Giving money back, behind a confirmation.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A TWO-STEP
 * ---------------------------------------------------------------------------
 *
 * A refund is irreversible from the customer's side and it is the one action on
 * the payments screen that moves money the wrong way. The confirmation states
 * the amount and the destination in words before the button does anything —
 * which is the part that catches "I meant 5,000 not 50,000".
 *
 * The amount is capped at `refundableMinor` in the UI AND on the server; the
 * database has `CHECK (refunded_minor <= amount_minor)` underneath both. The
 * cap here exists to give a sentence instead of a rejection, not to enforce
 * anything.
 */
export function RefundDialog({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const t = useT();
  const format = currencyFormat(payment.currencyCode);
  const refundable = BigInt(payment.refundableMinor);

  const [amount, setAmount] = useState(
    minorToDecimalString(payment.refundableMinor, format.minorUnit),
  );
  const [reason, setReason] = useState('');
  const [destination, setDestination] = useState(
    // A gift-card payment can only go back to the card. Handing cash over for a
    // card somebody was given is a different transaction entirely.
    payment.method === 'GIFT_CARD' ? 'GIFT_CARD' : 'ORIGINAL_METHOD',
  );
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const refund = useRefundPayment(payment.id);

  const money = (minor: string) =>
    formatMoney({ amountMinor: minor, currencyCode: payment.currencyCode }, format);

  const parsed = decimalToMinorString(amount, format.minorUnit);
  const amountError =
    parsed === null
      ? 'Enter an amount.'
      : BigInt(parsed) <= 0n
        ? 'A refund must be more than zero.'
        : BigInt(parsed) > refundable
          ? t('Only {money} is still refundable.', { money: money(payment.refundableMinor) })
          : null;

  const reasonError = reason.trim().length < 3 ? 'Say why — it goes on the audit trail.' : null;
  const canSubmit = !amountError && !reasonError && !refund.isPending;

  const submit = async () => {
    setError(null);
    try {
      await refund.mutateAsync({ amountMinor: parsed!, reason: reason.trim(), destination });
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('Could not process the refund.'));
      setConfirming(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="refund-title"
      className="border-border/60 bg-background grid max-w-lg gap-4 rounded-lg border p-4 shadow-sm"
    >
      <header className="grid gap-1">
        <h3 id="refund-title" className="text-sm font-semibold">
          {t('Refund {paymentNumber}', { paymentNumber: payment.paymentNumber })}
        </h3>
        <p className="text-muted-foreground text-xs">
          {money(payment.amountMinor)} {t('taken by')}{' '}
          {payment.method.toLowerCase().replace(/_/g, ' ')}
          {payment.refundedMinor !== '0'
            ? t(' · {money} already refunded', { money: money(payment.refundedMinor) })
            : ''}
        </p>
      </header>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('Could not refund')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {confirming ? (
        <Alert role="alert">
          <AlertTitle>
            {t('Refund')} {money(parsed!)}?
          </AlertTitle>
          <AlertDescription className="grid gap-3">
            <p>
              {destination === 'GIFT_CARD'
                ? t('The value goes back onto the gift card it came from.')
                : t('This records money going back the way it came. It cannot be undone here.')}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={refund.isPending}
                onClick={() => void submit()}
              >
                {refund.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t('Refund')} {money(parsed!)}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
                {t('Back')}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="refund-amount">
              {t('Amount ({currencyCode})', { currencyCode: payment.currencyCode })}
            </Label>
            <Input
              id="refund-amount"
              inputMode="decimal"
              value={amount}
              className="tabular-nums"
              onChange={(e) => setAmount(e.target.value)}
            />
            {amountError ? (
              <p role="alert" className="text-destructive text-xs">
                {amountError}
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                {t('Up to')} {money(payment.refundableMinor)}.
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="refund-destination">{t('Where it goes')}</Label>
            <select
              id="refund-destination"
              value={destination}
              disabled={payment.method === 'GIFT_CARD'}
              className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3 disabled:opacity-60"
              onChange={(e) => setDestination(e.target.value)}
            >
              <option value="ORIGINAL_METHOD">{t('Back the way it came')}</option>
              <option value="GIFT_CARD">{t('Onto a gift card')}</option>
              <option value="CASH">{t('Cash')}</option>
              <option value="BANK_TRANSFER">{t('Bank transfer')}</option>
            </select>
            {payment.method === 'GIFT_CARD' ? (
              <p className="text-muted-foreground text-xs">
                {t('A gift-card payment can only go back onto that card.')}
              </p>
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="refund-reason">{t('Reason')}</Label>
            <Input
              id="refund-reason"
              value={reason}
              maxLength={512}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('Service not performed')}
            />
            {reason.length > 0 && reasonError ? (
              <p role="alert" className="text-destructive text-xs">
                {reasonError}
              </p>
            ) : null}
          </div>

          <div className="flex gap-2">
            <Button size="sm" disabled={!canSubmit} onClick={() => setConfirming(true)}>
              {t('Continue')}
            </Button>
            <Button size="sm" variant="outline" onClick={onClose}>
              {t('Cancel')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
