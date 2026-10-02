'use client';

import { formatMoney } from '@undarga/shared';
import { Loader2, Search } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useBranches } from '@/features/branches';
import { useCompany } from '@/features/companies';
import { currencyFormat } from '@/lib/currency';
import type { Payment, PaymentMethod, PaymentQuery, PaymentStatus } from '@/services/billing.service';
import { usePayments } from '../api/use-billing';
import { RefundDialog } from './refund-dialog';

const PAGE_SIZE = 25;

const METHODS: PaymentMethod[] = ['CASH', 'CARD', 'BANK_TRANSFER', 'ONLINE', 'GIFT_CARD', 'OTHER'];
const STATUSES: PaymentStatus[] = ['SUCCEEDED', 'PENDING', 'AUTHORIZED', 'FAILED', 'CANCELLED'];

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

const label = (value: string) => value.toLowerCase().replace(/_/g, ' ');

/**
 * Every payment, with the totals for the filter rather than for the page.
 *
 * The summary at the top is the number the person on this screen came for —
 * "what did we take in March" — and it comes from a server-side aggregate over
 * the whole filter. Summing the twenty-five visible rows would answer a
 * different question and look like the same one.
 */
export function PaymentList() {
  const [search, setSearch] = useState('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [status, setStatus] = useState<PaymentStatus | ''>('');
  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [refunding, setRefunding] = useState<Payment | null>(null);

  const canRefund = useCan('payment:refund');
  const company = useCompany();
  const branches = useBranches();

  const currencyCode = company.data?.currencyCode ?? 'MNT';
  const money = (minor: string, code = currencyCode) =>
    formatMoney({ amountMinor: minor, currencyCode: code }, currencyFormat(code));

  const query: PaymentQuery = {
    ...(search ? { search } : {}),
    ...(method ? { method } : {}),
    ...(status ? { status } : {}),
    ...(branchId ? { branchId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: PAGE_SIZE,
    offset,
  };

  const payments = usePayments(query);
  const total = payments.data?.total ?? 0;
  const items = payments.data?.items ?? [];
  const filtered = Boolean(search || method || status || branchId || from || to);

  const changeFilter = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  return (
    <section className="grid gap-4">
      <header className="grid gap-1">
        <h2 className="text-lg font-semibold">Payments</h2>
        <p className="text-muted-foreground text-sm">
          {payments.isPending
            ? 'Loading…'
            : `${total} payment${total === 1 ? '' : 's'} · ${money(
                payments.data?.summary.netMinor ?? '0',
              )} net`}
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="payment-search">Reference</Label>
          <div className="relative">
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-4"
            />
            <Input
              id="payment-search"
              value={search}
              placeholder="PAY-…"
              className="pl-8 font-mono"
              onChange={(e) => changeFilter(() => setSearch(e.target.value))}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="payment-method">Method</Label>
          <select
            id="payment-method"
            value={method}
            className={selectClass}
            onChange={(e) => changeFilter(() => setMethod(e.target.value as PaymentMethod | ''))}
          >
            <option value="">All methods</option>
            {METHODS.map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="payment-status">Status</Label>
          <select
            id="payment-status"
            value={status}
            className={selectClass}
            onChange={(e) => changeFilter(() => setStatus(e.target.value as PaymentStatus | ''))}
          >
            <option value="">All</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="payment-branch">Branch</Label>
          <select
            id="payment-branch"
            value={branchId}
            className={selectClass}
            onChange={(e) => changeFilter(() => setBranchId(e.target.value))}
          >
            <option value="">All branches</option>
            {(branches.data?.items ?? []).map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="payment-from">From</Label>
          <Input
            id="payment-from"
            type="date"
            value={from}
            onChange={(e) => changeFilter(() => setFrom(e.target.value))}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="payment-to">To</Label>
          <Input
            id="payment-to"
            type="date"
            value={to}
            onChange={(e) => changeFilter(() => setTo(e.target.value))}
          />
        </div>
      </div>

      {payments.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not load payments</AlertTitle>
          <AlertDescription>Please try again.</AlertDescription>
        </Alert>
      ) : null}

      {payments.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">Loading payments…</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : null}

      {!payments.isPending && items.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">
            {filtered ? 'Nothing matches those filters' : 'No payments yet'}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {filtered
              ? 'Try widening the range.'
              : 'Payments appear here as they are taken against bookings.'}
          </p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">Reference</th>
                <th scope="col" className="py-2 pr-3 font-medium">When</th>
                <th scope="col" className="py-2 pr-3 font-medium">Customer</th>
                <th scope="col" className="py-2 pr-3 font-medium">Method</th>
                <th scope="col" className="py-2 pr-3 font-medium">Amount</th>
                <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((payment) => (
                <tr key={payment.id} className="border-border/40 border-b last:border-0">
                  <td className="py-2 pr-3 font-mono text-xs">{payment.paymentNumber}</td>
                  <td className="text-muted-foreground py-2 pr-3 whitespace-nowrap">
                    {new Date(payment.createdAt).toLocaleString()}
                  </td>
                  <td className="py-2 pr-3">{payment.customerName ?? '—'}</td>
                  <td className="py-2 pr-3">
                    {label(payment.method)}
                    {payment.purpose !== 'BOOKING' ? (
                      // Method and purpose are different questions: a deposit
                      // paid in cash is CASH/DEPOSIT, and the drawer count needs
                      // the first while the booking needs the second.
                      <span className="text-muted-foreground ml-1 text-xs">
                        ({label(payment.purpose)})
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">
                    {money(payment.amountMinor, payment.currencyCode)}
                    {payment.refundedMinor !== '0' ? (
                      <span className="text-muted-foreground ml-1 text-xs">
                        −{money(payment.refundedMinor, payment.currencyCode)}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">
                    <Badge
                      variant={payment.status === 'SUCCEEDED' ? 'default' : 'secondary'}
                      title={payment.failureReason ?? undefined}
                    >
                      {label(payment.status)}
                    </Badge>
                  </td>
                  <td className="py-2 text-right">
                    {canRefund &&
                    payment.status === 'SUCCEEDED' &&
                    payment.refundableMinor !== '0' ? (
                      <Button variant="ghost" size="sm" onClick={() => setRefunding(payment)}>
                        Refund
                      </Button>
                    ) : null}
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
              disabled={offset === 0 || payments.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || payments.isFetching}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {payments.isFetching ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {refunding ? (
        <RefundDialog payment={refunding} onClose={() => setRefunding(null)} />
      ) : null}
    </section>
  );
}
