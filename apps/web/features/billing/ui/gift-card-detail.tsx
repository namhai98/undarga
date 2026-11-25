'use client';

import { decimalToMinorString } from '@undarga/shared';
import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { currencyFormat } from '@/lib/currency';
import { ApiError } from '@/services/api-error';
import type { GiftCard, GiftCardTransaction } from '@/services/billing.service';
import { useGiftCard, useGiftCardActions, useGiftCardTransactions } from '../api/use-billing';
import {
  GIFT_CARD_STATUS_LABEL,
  TRANSACTION_LABEL,
  endOfDayIso,
  giftCardErrorMessage,
  giftCardMoney,
  giftCardStatusVariant,
  signedMoney,
  todayInputValue,
} from '../model/gift-card-display';
import { CustomerPicker, type PickedCustomer } from './customer-picker';
import { useT } from '@/lib/i18n';

const LEDGER_PAGE = 20;

type Panel = 'redeem' | 'edit' | 'disable' | 'void' | null;

/** A fresh key per attempt: a retry of the SAME attempt reuses it, a new attempt does not. */
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * One gift card: what it holds, who it belongs to, and every movement.
 *
 * Every number here is the server's. Redeeming and refunding send an amount
 * and an idempotency key; the new balance comes back from the server rather
 * than being subtracted here.
 */
export function GiftCardDetail({ giftCardId }: { giftCardId: string }) {
  const t = useT();
  const card = useGiftCard(giftCardId);
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canIssue = useCan('giftcard:issue');
  const canRedeem = useCan('giftcard:redeem');
  const canAdjust = useCan('giftcard:adjust');

  if (card.isPending) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <span className="sr-only">{t('Loading gift card…')}</span>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (card.error || !card.data) {
    const missing = card.error instanceof ApiError && card.error.status === 404;
    return (
      <div className="grid gap-4">
        <BackLink />
        <Alert variant={missing ? 'default' : 'destructive'} role="alert">
          <AlertTitle>
            {missing ? t('Gift card not found') : t('Could not load this gift card')}
          </AlertTitle>
          <AlertDescription>
            {missing
              ? t('It may belong to another company, or the link is wrong.')
              : t('Please try again.')}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const data = card.data;
  const closed = data.status === 'VOID';
  const done = (message: string) => {
    setPanel(null);
    setNotice(message);
  };

  return (
    <div className="grid gap-6">
      <BackLink />

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">
              {t('Gift card')} <span className="font-mono">••••-{data.last4}</span>
            </h1>
            <Badge variant={giftCardStatusVariant(data.status)}>
              {t(GIFT_CARD_STATUS_LABEL[data.status])}
            </Badge>
          </div>
          {!data.isRedeemable && data.problem ? (
            <p className="text-muted-foreground text-sm">{data.problem}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {canRedeem && data.isRedeemable ? (
            <Button size="sm" onClick={() => setPanel('redeem')}>
              {t('Redeem')}
            </Button>
          ) : null}
          {canIssue && !closed ? (
            <Button size="sm" variant="outline" onClick={() => setPanel('edit')}>
              {t('Edit')}
            </Button>
          ) : null}
          {canIssue && !closed && data.status !== 'DISABLED' ? (
            <Button size="sm" variant="outline" onClick={() => setPanel('disable')}>
              {t('Disable')}
            </Button>
          ) : null}
          {canAdjust && data.status === 'DISABLED' ? (
            <EnableButton card={data} onDone={() => done('Card re-enabled.')} />
          ) : null}
          {canAdjust && !closed ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => setPanel('void')}
            >
              {t('Void')}
            </Button>
          ) : null}
        </div>
      </header>

      {notice ? (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {panel === 'redeem' ? (
        <RedeemPanel card={data} onDone={done} onCancel={() => setPanel(null)} />
      ) : null}
      {panel === 'edit' ? (
        <EditPanel
          card={data}
          onDone={() => done('Card updated.')}
          onCancel={() => setPanel(null)}
        />
      ) : null}
      {panel === 'disable' ? (
        <ReasonPanel
          card={data}
          action="disable"
          onDone={() => done('Card disabled. Its balance is kept.')}
          onCancel={() => setPanel(null)}
        />
      ) : null}
      {panel === 'void' ? (
        <ReasonPanel
          card={data}
          action="void"
          onDone={() => done('Card voided.')}
          onCancel={() => setPanel(null)}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('Balance')}</CardTitle>
          <CardDescription>
            {t('Moves only through the ledger below — never edited directly.')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-3">
            <Detail label={t('Current balance')}>
              <span className="text-2xl font-semibold tabular-nums">
                {giftCardMoney(data.currentBalanceMinor, data.currencyCode)}
              </span>
            </Detail>
            <Detail label={t('Initial balance')}>
              <span className="tabular-nums">
                {giftCardMoney(data.initialBalanceMinor, data.currencyCode)}
              </span>
            </Detail>
            <Detail label={t('Currency')}>{data.currencyCode}</Detail>
            <Detail label={t('Status')}>{t(GIFT_CARD_STATUS_LABEL[data.status])}</Detail>
            <Detail label={t('Expiry')}>
              {data.expiresAt ? new Date(data.expiresAt).toLocaleDateString() : t('Never expires')}
            </Detail>
            <Detail label={t('Customer')}>
              {data.issuedToCustomerId ? (
                <Link href={`/customers/${data.issuedToCustomerId}`} className="hover:underline">
                  {data.issuedToName ?? t('Customer')}
                </Link>
              ) : (
                <span className="text-muted-foreground">{t('Not assigned')}</span>
              )}
            </Detail>
            {data.recipientName ? (
              <Detail label={t('Recipient')}>{data.recipientName}</Detail>
            ) : null}
            <Detail label={t('Issued')}>
              {data.issuedAt ? new Date(data.issuedAt).toLocaleDateString() : '—'}
            </Detail>
            {data.status === 'DISABLED' && data.disabledReason ? (
              <Detail label={t('Disabled because')}>{data.disabledReason}</Detail>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Ledger card={data} canRefund={canRedeem && !closed} onRefunded={done} />
    </div>
  );
}

// -----------------------------------------------------------------------------

function RedeemPanel({
  card,
  onDone,
  onCancel,
}: {
  card: GiftCard;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const format = currencyFormat(card.currencyCode);
  const actions = useGiftCardActions(card.id);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Held for the life of this form: a double click or a retry after a network
  // failure reuses it, and the server spends once.
  const [key] = useState(newIdempotencyKey);

  const parsed = decimalToMinorString(amount, format.minorUnit);
  const valid = parsed !== null && BigInt(parsed) > 0n;

  const submit = async () => {
    setError(null);
    if (parsed === null || !valid) {
      setError(t('Enter an amount.'));
      return;
    }
    try {
      const result = await actions.redeem.mutateAsync({
        amountMinor: parsed,
        ...(note.trim() ? { note: note.trim() } : {}),
        idempotencyKey: key,
      });
      onDone(
        t('Redeemed {giftCardMoney}. ', {
          giftCardMoney: giftCardMoney(parsed, card.currencyCode),
        }) +
          t('Balance now {giftCardMoney}.', {
            giftCardMoney: giftCardMoney(result.card.currentBalanceMinor, card.currencyCode),
          }),
      );
    } catch (caught) {
      setError(giftCardErrorMessage(caught, 'Could not redeem the card.'));
    }
  };

  return (
    <Panel title={t('Redeem')} error={error}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="redeem-amount">
            {t('Amount ({currencyCode})', { currencyCode: card.currencyCode })}
          </Label>
          <Input
            id="redeem-amount"
            inputMode="decimal"
            value={amount}
            className="tabular-nums"
            onChange={(e) => setAmount(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            {t('Up to')} {giftCardMoney(card.currentBalanceMinor, card.currencyCode)}.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="redeem-note">{t('Note')}</Label>
          <Input
            id="redeem-note"
            value={note}
            maxLength={512}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
      <PanelButtons
        label={t('Redeem')}
        pending={actions.redeem.isPending}
        disabled={!valid}
        onSubmit={() => void submit()}
        onCancel={onCancel}
      />
    </Panel>
  );
}

function EditPanel({
  card,
  onDone,
  onCancel,
}: {
  card: GiftCard;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const actions = useGiftCardActions(card.id);
  const [customer, setCustomer] = useState<PickedCustomer | null>(
    card.issuedToCustomerId
      ? { id: card.issuedToCustomerId, name: card.issuedToName ?? 'Customer' }
      : null,
  );
  const [neverExpires, setNeverExpires] = useState(card.expiresAt === null);
  const [expiresOn, setExpiresOn] = useState(card.expiresAt ? card.expiresAt.slice(0, 10) : '');
  const [recipientName, setRecipientName] = useState(card.recipientName ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const originalDay = card.expiresAt ? card.expiresAt.slice(0, 10) : '';
    const expiryChanged = neverExpires ? card.expiresAt !== null : expiresOn !== originalDay;
    if (!neverExpires && !expiresOn) {
      setError(t('Choose an expiry date, or tick “Never expires”.'));
      return;
    }
    try {
      await actions.update.mutateAsync({
        issuedToCustomerId: customer?.id ?? null,
        recipientName: recipientName.trim() || null,
        // Only sent when changed: re-sending an expiry that has already passed
        // would be refused as a date in the past.
        ...(expiryChanged ? { expiresAt: neverExpires ? null : endOfDayIso(expiresOn) } : {}),
      });
      onDone();
    } catch (caught) {
      setError(giftCardErrorMessage(caught, 'Could not update the card.'));
    }
  };

  return (
    <Panel title={t('Edit gift card')} error={error}>
      <div className="grid gap-4 sm:grid-cols-2">
        <CustomerPicker id="edit-customer" value={customer} onChange={setCustomer} />
        <div className="grid gap-1.5">
          <Label htmlFor="edit-recipient">{t('Recipient name')}</Label>
          <Input
            id="edit-recipient"
            value={recipientName}
            maxLength={128}
            onChange={(e) => setRecipientName(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="edit-expires">{t('Expires')}</Label>
          <Input
            id="edit-expires"
            type="date"
            min={todayInputValue()}
            value={expiresOn}
            disabled={neverExpires}
            onChange={(e) => setExpiresOn(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={neverExpires}
              onChange={(e) => setNeverExpires(e.target.checked)}
            />
            {t('Never expires')}
          </label>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        {t('The balance and currency cannot be edited. To correct a balance, use an adjustment.')}
      </p>
      <PanelButtons
        label={t('Save')}
        pending={actions.update.isPending}
        onSubmit={() => void submit()}
        onCancel={onCancel}
      />
    </Panel>
  );
}

function ReasonPanel({
  card,
  action,
  onDone,
  onCancel,
}: {
  card: GiftCard;
  action: 'disable' | 'void';
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const actions = useGiftCardActions(card.id);
  const pending = action === 'disable' ? actions.disable.isPending : actions.void.isPending;
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      if (action === 'disable') await actions.disable.mutateAsync(reason.trim());
      else await actions.void.mutateAsync(reason.trim());
      onDone();
    } catch (caught) {
      setError(giftCardErrorMessage(caught, t('Could not {action} the card.', { action })));
    }
  };

  return (
    <Panel title={action === 'disable' ? 'Disable this card?' : 'Void this card?'} error={error}>
      <p className="text-sm">
        {action === 'disable'
          ? t('It cannot be used until it is re-enabled. Its balance is kept.')
          : t(
              'The remaining balance ({giftCardMoney}) is written off and the card can never be used again. To stop it temporarily, disable it instead.',
              { giftCardMoney: giftCardMoney(card.currentBalanceMinor, card.currencyCode) },
            )}
      </p>
      <div className="grid gap-1.5">
        <Label htmlFor={`${action}-reason`}>{t('Reason')}</Label>
        <Input
          id={`${action}-reason`}
          value={reason}
          maxLength={512}
          placeholder={action === 'disable' ? 'Reported lost' : 'Issued in error'}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <PanelButtons
        label={action === 'disable' ? 'Disable' : 'Void'}
        destructive
        pending={pending}
        disabled={reason.trim().length < 3}
        onSubmit={() => void submit()}
        onCancel={onCancel}
      />
    </Panel>
  );
}

function EnableButton({ card, onDone }: { card: GiftCard; onDone: () => void }) {
  const t = useT();
  const actions = useGiftCardActions(card.id);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={actions.enable.isPending}
        onClick={() => {
          setError(null);
          actions.enable.mutate(undefined, {
            onSuccess: onDone,
            onError: (caught) =>
              setError(giftCardErrorMessage(caught, 'Could not re-enable the card.')),
          });
        }}
      >
        {actions.enable.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {t('Re-enable')}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive w-full text-sm">
          {error}
        </p>
      ) : null}
    </>
  );
}

// -----------------------------------------------------------------------------

function Ledger({
  card,
  canRefund,
  onRefunded,
}: {
  card: GiftCard;
  canRefund: boolean;
  onRefunded: (message: string) => void;
}) {
  const t = useT();
  const [offset, setOffset] = useState(0);
  const [refunding, setRefunding] = useState<GiftCardTransaction | null>(null);
  const transactions = useGiftCardTransactions(card.id, { limit: LEDGER_PAGE, offset });
  const items = transactions.data?.items ?? [];
  const total = transactions.data?.total ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Transactions')}</CardTitle>
        <CardDescription>
          {t('Append-only. Every balance change is a row here, with the balance it left.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {refunding ? (
          <RefundPanel
            card={card}
            redemption={refunding}
            onDone={(message) => {
              setRefunding(null);
              onRefunded(message);
            }}
            onCancel={() => setRefunding(null)}
          />
        ) : null}

        {transactions.error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{t('Could not load transactions')}</AlertTitle>
            <AlertDescription>{t('Please try again.')}</AlertDescription>
          </Alert>
        ) : null}

        {transactions.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('When')}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('Type')}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('Amount')}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('Balance after')}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('Note')}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} className="border-border/40 border-b last:border-0">
                    <td className="text-muted-foreground py-1.5 pr-3 whitespace-nowrap">
                      {new Date(row.occurredAt).toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-3">{t(TRANSACTION_LABEL[row.type])}</td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {signedMoney(row.amountMinor, row.currencyCode)}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {giftCardMoney(row.balanceAfterMinor, row.currencyCode)}
                    </td>
                    <td className="text-muted-foreground py-1.5 pr-3 text-xs">
                      {row.reason ?? (row.paymentId ? t('Payment') : '')}
                      {row.refundedMinor && row.refundedMinor !== '0' ? (
                        <span className="block">
                          {t('{amount} refunded', {
                            amount: giftCardMoney(row.refundedMinor, row.currencyCode),
                          })}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1.5 text-right">
                      {canRefund &&
                      row.type === 'REDEEM' &&
                      row.refundableMinor &&
                      row.refundableMinor !== '0' ? (
                        <Button variant="ghost" size="sm" onClick={() => setRefunding(row)}>
                          {t('Refund')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > LEDGER_PAGE ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">
              {t('{from}–{to} of {total}', {
                from: offset + 1,
                to: Math.min(offset + LEDGER_PAGE, total),
                total: total,
              })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - LEDGER_PAGE))}
              >
                {t('Newer')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + LEDGER_PAGE >= total}
                onClick={() => setOffset(offset + LEDGER_PAGE)}
              >
                {t('Older')}
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RefundPanel({
  card,
  redemption,
  onDone,
  onCancel,
}: {
  card: GiftCard;
  redemption: GiftCardTransaction;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const format = currencyFormat(card.currencyCode);
  const refundable = redemption.refundableMinor ?? '0';
  const actions = useGiftCardActions(card.id);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(newIdempotencyKey);

  // Blank = everything still refundable; the server works that out.
  const parsed = amount.trim() ? decimalToMinorString(amount, format.minorUnit) : null;
  const amountInvalid = amount.trim() !== '' && (parsed === null || BigInt(parsed) <= 0n);

  const submit = async () => {
    setError(null);
    try {
      const result = await actions.refund.mutateAsync({
        transactionId: redemption.id,
        ...(parsed ? { amountMinor: parsed } : {}),
        reason: reason.trim(),
        idempotencyKey: key,
      });
      onDone(
        t('Refunded to the card. Balance now {giftCardMoney}.', {
          giftCardMoney: giftCardMoney(result.card.currentBalanceMinor, card.currencyCode),
        }),
      );
    } catch (caught) {
      setError(giftCardErrorMessage(caught, 'Could not refund.'));
    }
  };

  return (
    <Panel title={t('Refund a redemption')} error={error}>
      <p className="text-sm">
        {t('Up to')} {giftCardMoney(refundable, card.currencyCode)}{' '}
        {t('of this redemption can go back on the card.')}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="refund-amount">
            {t('Amount ({currencyCode})', { currencyCode: card.currencyCode })}
          </Label>
          <Input
            id="refund-amount"
            inputMode="decimal"
            value={amount}
            placeholder={t('All of it')}
            className="tabular-nums"
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="refund-reason">{t('Reason')}</Label>
          <Input
            id="refund-reason"
            value={reason}
            maxLength={512}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </div>
      <PanelButtons
        label={t('Refund')}
        pending={actions.refund.isPending}
        disabled={amountInvalid || reason.trim().length < 3}
        onSubmit={() => void submit()}
        onCancel={onCancel}
      />
    </Panel>
  );
}

// -----------------------------------------------------------------------------

function Panel({
  title,
  error,
  children,
}: {
  title: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="border-border/60 grid gap-4 rounded-lg border p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {children}
    </section>
  );
}

function PanelButtons(props: {
  label: string;
  pending: boolean;
  disabled?: boolean;
  destructive?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        variant={props.destructive ? 'destructive' : 'default'}
        disabled={props.pending || props.disabled}
        onClick={props.onSubmit}
      >
        {props.pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {props.label}
      </Button>
      <Button size="sm" variant="outline" onClick={props.onCancel}>
        {t('Cancel')}
      </Button>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link
      href="/gift-cards"
      className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} w-fit`}
    >
      <ArrowLeft aria-hidden className="size-4" />
      {t('Gift cards')}
    </Link>
  );
}
