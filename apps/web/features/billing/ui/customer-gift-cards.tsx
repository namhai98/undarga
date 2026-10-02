'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useCompany } from '@/features/companies';
import { useCustomer } from '@/features/customers';
import type { IssuedGiftCard } from '@/services/billing.service';
import { useGiftCards } from '../api/use-billing';
import {
  GIFT_CARD_STATUS_LABEL,
  giftCardMoney,
  giftCardStatusVariant,
} from '../model/gift-card-display';
import { IssueForm } from './gift-card-list';

/**
 * The gift cards that belong to one customer, on their page.
 *
 * Not rendered at all for a viewer without `giftcard:read`, so there is no
 * request to be refused. Issuing from here pre-assigns the customer.
 */
export function CustomerGiftCards({ customerId }: { customerId: string }) {
  const canRead = useCan('giftcard:read');
  const canIssue = useCan('giftcard:issue');
  const company = useCompany();
  // Already cached by the customer page this renders inside.
  const customer = useCustomer(customerId);
  const customerName = customer.data?.fullName ?? 'this customer';
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<IssuedGiftCard | null>(null);

  const cards = useGiftCards({ issuedToCustomerId: customerId, limit: 50 }, { enabled: canRead });
  if (!canRead) return null;

  const items = cards.data?.items ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <CardTitle>Gift cards</CardTitle>
          <CardDescription>
            {cards.isPending
              ? 'Loading…'
              : `${cards.data?.total ?? 0} assigned to ${customerName}.`}
          </CardDescription>
        </div>
        {canIssue && !issuing ? (
          <Button size="sm" variant="outline" onClick={() => setIssuing(true)}>
            Issue a card
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-3">
        {issued ? (
          <div role="alert" className="bg-muted grid gap-2 rounded-lg p-3 text-sm">
            <p className="font-medium">Card issued — this code will not be shown again:</p>
            <code className="font-mono text-base tracking-widest">{issued.code}</code>
            <Button size="sm" variant="ghost" className="w-fit" onClick={() => setIssued(null)}>
              I have it
            </Button>
          </div>
        ) : null}

        {issuing ? (
          <IssueForm
            currencyCode={company.data?.currencyCode ?? 'MNT'}
            customer={{ id: customerId, name: customerName }}
            onDone={(card) => {
              setIssuing(false);
              setIssued(card);
            }}
            onCancel={() => setIssuing(false)}
          />
        ) : null}

        {cards.isPending ? <Skeleton className="h-12 w-full" /> : null}

        {cards.error ? (
          <p role="alert" className="text-destructive text-sm">
            Could not load gift cards.
          </p>
        ) : null}

        {!cards.isPending && !cards.error && items.length === 0 ? (
          <p className="text-muted-foreground text-sm">No gift cards.</p>
        ) : null}

        {items.length > 0 ? (
          <ul className="divide-border/40 grid divide-y text-sm">
            {items.map((card) => (
              <li key={card.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link href={`/gift-cards/${card.id}`} className="font-mono text-xs hover:underline">
                  ••••-{card.last4}
                </Link>
                <span className="tabular-nums">
                  {giftCardMoney(card.currentBalanceMinor, card.currencyCode)}
                  <span className="text-muted-foreground ml-1 text-xs">
                    of {giftCardMoney(card.initialBalanceMinor, card.currencyCode)}
                  </span>
                </span>
                <span className="text-muted-foreground text-xs">
                  {card.expiresAt
                    ? `Expires ${new Date(card.expiresAt).toLocaleDateString()}`
                    : 'No expiry'}
                </span>
                <Badge variant={giftCardStatusVariant(card.status)}>
                  {GIFT_CARD_STATUS_LABEL[card.status]}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
