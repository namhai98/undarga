'use client';

import { decimalToMinorString } from '@undarga/shared';
import { Copy, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useCompany } from '@/features/companies';
import { currencyFormat } from '@/lib/currency';
import { ApiError } from '@/services/api-error';
import type { GiftCardLookup, GiftCardStatus, IssuedGiftCard } from '@/services/billing.service';
import { useGiftCardLookup, useGiftCards, useIssueGiftCard } from '../api/use-billing';
import {
  GIFT_CARD_FILTER_STATUSES,
  GIFT_CARD_STATUS_LABEL,
  endOfDayIso,
  giftCardErrorMessage,
  giftCardMoney,
  giftCardStatusVariant,
  todayInputValue,
} from '../model/gift-card-display';
import { CustomerPicker, type PickedCustomer } from './customer-picker';

const PAGE_SIZE = 25;
const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/**
 * Stored value.
 *
 * ---------------------------------------------------------------------------
 * THE CODE IS SHOWN ONCE AND THEN GONE
 * ---------------------------------------------------------------------------
 *
 * Only an HMAC is stored, so no later request can hand the code back. The panel
 * below is the only place it will ever exist, and dismissing it is
 * irreversible — which the panel says, because somebody who closes it without
 * reading has to void the card and issue another.
 *
 * Searching by code still works: the server hashes what is typed and matches
 * it exactly. The last four characters, or the customer, work too.
 */
export function GiftCardList() {
  const [status, setStatus] = useState<GiftCardStatus | ''>('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<IssuedGiftCard | null>(null);

  const canIssue = useCan('giftcard:issue');
  const company = useCompany();
  const currencyCode = company.data?.currencyCode ?? 'MNT';

  // Debounced: every keystroke would otherwise be a request.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const cards = useGiftCards({
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
    limit: PAGE_SIZE,
    offset,
  });

  const total = cards.data?.total ?? 0;
  const items = cards.data?.items ?? [];
  const filtered = Boolean(status || search);

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold">Gift cards</h2>
          <p className="text-muted-foreground text-sm">
            {cards.isPending ? 'Loading…' : `${total} card${total === 1 ? '' : 's'}`}
          </p>
        </div>
        {canIssue ? (
          <Button size="sm" onClick={() => setIssuing(true)} disabled={issuing}>
            Issue a card
          </Button>
        ) : null}
      </header>

      {issued ? <IssuedPanel card={issued} onDismiss={() => setIssued(null)} /> : null}

      {issuing ? (
        <IssueForm
          currencyCode={currencyCode}
          onDone={(card) => {
            setIssuing(false);
            setIssued(card);
          }}
          onCancel={() => setIssuing(false)}
        />
      ) : null}

      <BalanceCheck />

      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <div className="grid gap-1.5">
          <Label htmlFor="card-search">Search</Label>
          <Input
            id="card-search"
            value={searchInput}
            placeholder="Code, last four, or customer"
            autoComplete="off"
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="card-status">Status</Label>
          <select
            id="card-status"
            value={status}
            className={selectClass}
            onChange={(e) => {
              setStatus(e.target.value as GiftCardStatus | '');
              setOffset(0);
            }}
          >
            <option value="">All</option>
            {GIFT_CARD_FILTER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {GIFT_CARD_STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {cards.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not load gift cards</AlertTitle>
          <AlertDescription>Please try again.</AlertDescription>
        </Alert>
      ) : null}

      {cards.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">Loading gift cards…</span>
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : null}

      {!cards.isPending && !cards.error && items.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">
            {filtered ? 'No matching gift cards' : 'No gift cards'}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {filtered
              ? 'Try the full code, its last four characters, or the customer’s name.'
              : 'Issued cards appear here. Only the last four characters are ever stored.'}
          </p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Card
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Customer
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Balance
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Expires
                </th>
                <th scope="col" className="py-2 font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((card) => (
                <tr key={card.id} className="border-border/40 border-b last:border-0">
                  <td className="py-2 pr-3">
                    <Link
                      href={`/gift-cards/${card.id}`}
                      className="font-mono text-xs hover:underline"
                    >
                      ••••-{card.last4}
                    </Link>
                  </td>
                  <td className="py-2 pr-3">
                    {card.issuedToName ?? card.recipientName ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">
                    {giftCardMoney(card.currentBalanceMinor, card.currencyCode)}
                    <span className="text-muted-foreground ml-1 text-xs">
                      of {giftCardMoney(card.initialBalanceMinor, card.currencyCode)}
                    </span>
                  </td>
                  <td className="text-muted-foreground py-2 pr-3">
                    {card.expiresAt ? new Date(card.expiresAt).toLocaleDateString() : 'Never'}
                  </td>
                  <td className="py-2">
                    <Badge variant={giftCardStatusVariant(card.status)}>
                      {GIFT_CARD_STATUS_LABEL[card.status]}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function IssuedPanel({ card, onDismiss }: { card: IssuedGiftCard; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <Alert role="alert">
      <AlertTitle>Card issued — write this down now</AlertTitle>
      <AlertDescription className="grid gap-3">
        <p>
          This code is not stored and cannot be shown again. If it is lost, the card has to be
          voided and a new one issued.
        </p>
        <code className="bg-muted rounded px-3 py-2 font-mono text-base tracking-widest">
          {card.code}
        </code>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(card.code).then(() => setCopied(true));
            }}
          >
            <Copy aria-hidden className="size-4" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Link
            href={`/gift-cards/${card.id}`}
            className={buttonVariants({ size: 'sm', variant: 'outline' })}
          >
            Open card
          </Link>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            I have it
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** Issue a card, optionally for a customer. Exported for the customer page. */
export function IssueForm({
  currencyCode,
  customer: initialCustomer = null,
  onDone,
  onCancel,
}: {
  currencyCode: string;
  customer?: PickedCustomer | null;
  onDone: (card: IssuedGiftCard) => void;
  onCancel: () => void;
}) {
  const format = currencyFormat(currencyCode);
  const [amount, setAmount] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [customer, setCustomer] = useState<PickedCustomer | null>(initialCustomer);
  const [error, setError] = useState<string | null>(null);

  const issue = useIssueGiftCard();
  const parsed = decimalToMinorString(amount, format.minorUnit);
  const amountError =
    amount.length === 0
      ? null
      : parsed === null || BigInt(parsed) <= 0n
        ? 'Enter an amount.'
        : null;

  const submit = async () => {
    setError(null);
    if (!parsed || BigInt(parsed) <= 0n) {
      setError('Load some value onto the card.');
      return;
    }
    try {
      const card = await issue.mutateAsync({
        initialBalanceMinor: parsed,
        ...(customer ? { issuedToCustomerId: customer.id } : {}),
        ...(recipientName.trim() ? { recipientName: recipientName.trim() } : {}),
        // Omitted means never expires, which is the safe default: expiry on
        // stored value is restricted in many jurisdictions.
        ...(expiresAt ? { expiresAt: endOfDayIso(expiresAt) } : {}),
      });
      onDone(card);
    } catch (caught) {
      setError(giftCardErrorMessage(caught, 'Could not issue the card.'));
    }
  };

  return (
    <div className="border-border/60 grid gap-4 rounded-lg border p-4">
      <h3 className="text-sm font-medium">Issue a gift card</h3>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not issue</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="issue-amount">Initial balance ({currencyCode})</Label>
          <Input
            id="issue-amount"
            inputMode="decimal"
            value={amount}
            className="tabular-nums"
            onChange={(e) => setAmount(e.target.value)}
          />
          {amountError ? (
            <p role="alert" className="text-destructive text-xs">
              {amountError}
            </p>
          ) : null}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="issue-expires">Expires</Label>
          <Input
            id="issue-expires"
            type="date"
            min={todayInputValue()}
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">Leave blank for never.</p>
        </div>
        <CustomerPicker id="issue-customer" value={customer} onChange={setCustomer} />
        <div className="grid gap-1.5">
          <Label htmlFor="issue-recipient">Recipient name</Label>
          <Input
            id="issue-recipient"
            value={recipientName}
            maxLength={128}
            onChange={(e) => setRecipientName(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">For a gift to someone not on file.</p>
        </div>
      </div>

      <div className="flex gap-2">
        <Button size="sm" disabled={issue.isPending} onClick={() => void submit()}>
          {issue.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Issue
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** What the till uses before taking a payment: the code as the customer reads it. */
function BalanceCheck() {
  const [code, setCode] = useState('');
  const [result, setResult] = useState<GiftCardLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lookup = useGiftCardLookup();

  const check = async () => {
    setError(null);
    setResult(null);
    try {
      setResult(await lookup.mutateAsync(code));
    } catch (caught) {
      // A wrong code and another company's card are the same 404 — anything
      // else is an oracle for guessing codes.
      setError(caught instanceof ApiError ? 'No card for that code.' : 'Lookup failed.');
    }
  };

  return (
    <div className="border-border/60 grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid flex-1 gap-1.5">
          <Label htmlFor="card-check">Check a balance</Label>
          <Input
            id="card-check"
            value={code}
            placeholder="ABCD-EFGH-JKMN-PQRS"
            autoComplete="off"
            className="font-mono uppercase"
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          disabled={code.length < 4 || lookup.isPending}
          onClick={() => void check()}
        >
          {lookup.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Check
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}

      {result ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Link href={`/gift-cards/${result.id}`} className="font-mono text-xs hover:underline">
            ••••-{result.last4}
          </Link>
          <span className="font-semibold tabular-nums">
            {giftCardMoney(result.currentBalanceMinor, result.currencyCode)}
          </span>
          {result.isRedeemable ? (
            <Badge variant="default">Usable</Badge>
          ) : (
            <span className="text-destructive">{result.problem}</span>
          )}
        </p>
      ) : null}
    </div>
  );
}
