'use client';

import { CalendarDays, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/services/api-error';
import type { PortalAppointment, PortalAppointmentScope } from '@/services/customer-portal.service';
import {
  useCustomerAppointments,
  useCustomerGiftCards,
  useCustomerPayments,
  useCustomerProfile,
  useGiftCardHistory,
  useUpdateProfile,
} from '../api/use-customer-portal';
import { GIFT_TXN_LABEL, METHOD_LABEL, STATUS_LABEL, day, money, statusTone, when } from '../model/format';

const PAGE = 10;

// =============================================================================
// Overview
// =============================================================================

export function PortalOverview({ slug }: { slug: string }) {
  const profile = useCustomerProfile(slug);
  const upcoming = useCustomerAppointments(slug, 'upcoming', 0, 3);
  const cards = useCustomerGiftCards(slug);
  const payments = useCustomerPayments(slug, 0, 3);

  const held = (cards.data?.items ?? []).filter((c) => c.relation === 'HOLDER' && c.status === 'ACTIVE');

  return (
    <div className="grid gap-6">
      <h1 className="text-xl font-semibold">
        {profile.data ? `Hello, ${profile.data.firstName}` : 'Hello'}
      </h1>

      <Card>
        <CardHeader>
          <CardTitle>Coming up</CardTitle>
          <CardDescription>Your next appointments.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Loadable query={upcoming} label="Loading your appointments…" error="Could not load your appointments.">
            {(data) =>
              data.items.length === 0 ? (
                <Empty title="Nothing booked" body="When you book, your appointments appear here.">
                  <Link href={`/book/${slug}`} className={buttonVariants({ size: 'sm' })}>
                    Book an appointment
                  </Link>
                </Empty>
              ) : (
                <>
                  <AppointmentRows slug={slug} items={data.items} />
                  {data.total > data.items.length ? (
                    <Link href={`/portal/${slug}/appointments`} className="text-sm underline underline-offset-4">
                      See all {data.total}
                    </Link>
                  ) : null}
                </>
              )
            }
          </Loadable>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Gift cards</CardTitle>
          </CardHeader>
          <CardContent>
            <Loadable query={cards} label="Loading gift cards…" error="Could not load your gift cards.">
              {() =>
                held.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No active gift cards.</p>
                ) : (
                  <ul className="grid gap-2">
                    {held.map((card) => (
                      <li key={card.id} className="flex justify-between gap-3 text-sm">
                        <span className="font-mono">•••• {card.codeLast4}</span>
                        <span className="font-medium tabular-nums">{money(card.balanceMinor!, card.currencyCode)}</span>
                      </li>
                    ))}
                  </ul>
                )
              }
            </Loadable>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recent payments</CardTitle>
          </CardHeader>
          <CardContent>
            <Loadable query={payments} label="Loading payments…" error="Could not load your payments.">
              {(data) =>
                data.items.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No payments yet.</p>
                ) : (
                  <ul className="grid gap-2">
                    {data.items.map((payment) => (
                      <li key={payment.id} className="flex justify-between gap-3 text-sm">
                        <span>
                          {day(payment.paidAt)} · {METHOD_LABEL[payment.method] ?? payment.method}
                          {payment.status !== 'SUCCEEDED' ? ` · ${payment.status.toLowerCase()}` : ''}
                        </span>
                        <span className="tabular-nums">{money(payment.amountMinor, payment.currencyCode)}</span>
                      </li>
                    ))}
                  </ul>
                )
              }
            </Loadable>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// =============================================================================
// Appointments
// =============================================================================

const TABS: Array<{ scope: PortalAppointmentScope; label: string; empty: string }> = [
  { scope: 'upcoming', label: 'Upcoming', empty: 'You have no upcoming appointments.' },
  { scope: 'past', label: 'Past', empty: 'No past appointments yet.' },
  { scope: 'cancelled', label: 'Cancelled', empty: 'No cancelled appointments.' },
];

export function PortalAppointments({ slug }: { slug: string }) {
  const [scope, setScope] = useState<PortalAppointmentScope>('upcoming');
  const [offset, setOffset] = useState(0);
  const list = useCustomerAppointments(slug, scope, offset, PAGE);
  const tab = TABS.find((t) => t.scope === scope)!;

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">My appointments</h1>
      <div role="tablist" aria-label="Appointments" className="flex gap-2">
        {TABS.map((t) => (
          <Button
            key={t.scope}
            role="tab"
            aria-selected={t.scope === scope}
            variant={t.scope === scope ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setScope(t.scope);
              setOffset(0);
            }}
          >
            {t.label}
          </Button>
        ))}
      </div>

      <Loadable query={list} label="Loading your appointments…" error="Could not load your appointments.">
        {(data) =>
          data.items.length === 0 ? (
            <Empty title={tab.empty} body="">
              {scope === 'upcoming' ? (
                <Link href={`/book/${slug}`} className={buttonVariants({ size: 'sm' })}>
                  Book an appointment
                </Link>
              ) : null}
            </Empty>
          ) : (
            <>
              <AppointmentRows slug={slug} items={data.items} />
              <Pager offset={offset} total={data.total} pageSize={PAGE} busy={list.isFetching} onChange={setOffset} />
            </>
          )
        }
      </Loadable>
    </div>
  );
}

function AppointmentRows({ slug, items }: { slug: string; items: PortalAppointment[] }) {
  return (
    <ul className="grid gap-2">
      {items.map((a) => (
        <li key={a.id}>
          <Link
            href={`/portal/${slug}/appointments/${a.id}`}
            className="border-border/60 hover:bg-muted/50 grid gap-1 rounded-lg border p-3 transition-colors"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{a.service ?? 'Appointment'}</span>
              <Badge variant={statusTone(a.status)}>{STATUS_LABEL[a.status]}</Badge>
            </div>
            <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <CalendarDays aria-hidden className="size-4" />
              {when(a.startsAt, a.timezone)}
            </span>
            <span className="text-muted-foreground text-xs">
              {[a.branch, a.employee].filter(Boolean).join(' · ')} · {money(a.totalMinor, a.currencyCode)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

// =============================================================================
// Profile
// =============================================================================

export function PortalProfile({ slug }: { slug: string }) {
  const profile = useCustomerProfile(slug);
  return (
    <div className="grid max-w-lg gap-4">
      <h1 className="text-xl font-semibold">My profile</h1>
      <Loadable query={profile} label="Loading your profile…" error="Could not load your profile.">
        {(data) => <ProfileForm slug={slug} initial={data} />}
      </Loadable>
    </div>
  );
}

function ProfileForm({
  slug,
  initial,
}: {
  slug: string;
  initial: { firstName: string; lastName: string | null; phone: string | null; email: string | null };
}) {
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName ?? '');
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const update = useUpdateProfile(slug);

  const save = async () => {
    setMessage(null);
    const found: Record<string, string> = {};
    if (!firstName.trim()) found.firstName = 'Enter your first name.';
    if (phone.trim() && !/^\+?[\d\s()./-]{6,}$/.test(phone.trim())) found.phone = 'Enter a phone number.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      await update.mutateAsync({
        firstName: firstName.trim(),
        lastName: lastName.trim() || null,
        phone: phone.trim() || null,
      });
      setMessage({ ok: true, text: 'Your details were saved.' });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'CONFLICT') {
        setErrors({ phone: caught.message });
      } else {
        setMessage({ ok: false, text: caught instanceof ApiError ? caught.message : 'Could not save. Try again.' });
      }
    }
  };

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {message ? (
        <Alert variant={message.ok ? 'default' : 'destructive'} role={message.ok ? 'status' : 'alert'}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="firstName" label="First name" error={errors.firstName}>
          <Input id="firstName" value={firstName} maxLength={96} onChange={(e) => setFirstName(e.target.value)} />
        </Field>
        <Field id="lastName" label="Last name">
          <Input id="lastName" value={lastName} maxLength={96} onChange={(e) => setLastName(e.target.value)} />
        </Field>
      </div>
      <Field id="phone" label="Phone" error={errors.phone}>
        <Input id="phone" type="tel" value={phone} maxLength={32} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <Field id="email" label="Email" hint="You sign in with this address. Ask the business to change it.">
        <Input id="email" value={initial.email ?? ''} readOnly disabled />
      </Field>
      <Button type="submit" className="w-fit" disabled={update.isPending}>
        {update.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
        Save
      </Button>
    </form>
  );
}

// =============================================================================
// Gift cards
// =============================================================================

export function PortalGiftCards({ slug }: { slug: string }) {
  const cards = useCustomerGiftCards(slug);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">My gift cards</h1>
      <Loadable query={cards} label="Loading gift cards…" error="Could not load your gift cards.">
        {(data) =>
          data.items.length === 0 ? (
            <Empty title="No gift cards" body="Gift cards you hold or buy here appear on this page." />
          ) : (
            <ul className="grid gap-3">
              {data.items.map((card) => (
                <li key={card.id} className="border-border/60 grid gap-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono">•••• {card.codeLast4}</span>
                    <Badge variant={card.status === 'ACTIVE' ? 'default' : 'outline'}>
                      {card.status.toLowerCase().replace(/_/g, ' ')}
                    </Badge>
                  </div>
                  {card.relation === 'HOLDER' ? (
                    <>
                      <p className="text-2xl font-semibold tabular-nums">{money(card.balanceMinor!, card.currencyCode)}</p>
                      <p className="text-muted-foreground text-xs">
                        of {money(card.initialBalanceMinor, card.currencyCode)}
                        {card.expiresAt ? ` · expires ${day(card.expiresAt)}` : ' · no expiry'}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-fit"
                        aria-expanded={open === card.id}
                        onClick={() => setOpen(open === card.id ? null : card.id)}
                      >
                        {open === card.id ? 'Hide history' : 'Show history'}
                      </Button>
                      {open === card.id ? <GiftCardHistoryList slug={slug} id={card.id} /> : null}
                    </>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      You bought this {money(card.initialBalanceMinor, card.currencyCode)} card
                      {card.recipientName ? ` for ${card.recipientName}` : ''}. Its balance is theirs to see.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </Loadable>
    </div>
  );
}

function GiftCardHistoryList({ slug, id }: { slug: string; id: string }) {
  const [offset, setOffset] = useState(0);
  const history = useGiftCardHistory(slug, id, offset, PAGE);
  return (
    <Loadable query={history} label="Loading history…" error="Could not load this card’s history.">
      {(data) =>
        data.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">No activity yet.</p>
        ) : (
          <>
            <ul className="grid gap-1.5 text-sm">
              {data.items.map((row) => (
                <li key={row.id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    {day(row.occurredAt)} · {GIFT_TXN_LABEL[row.type] ?? row.type}
                    {row.appointmentNumber ? ` · ${row.appointmentNumber}` : ''}
                  </span>
                  <span className="tabular-nums">
                    {money(row.amountMinor, row.currencyCode)}
                    <span className="text-muted-foreground"> → {money(row.balanceAfterMinor, row.currencyCode)}</span>
                  </span>
                </li>
              ))}
            </ul>
            <Pager offset={offset} total={data.total} pageSize={PAGE} busy={history.isFetching} onChange={setOffset} />
          </>
        )
      }
    </Loadable>
  );
}

// =============================================================================
// Shared bits
// =============================================================================

export function Loadable<T>({
  query,
  label,
  error,
  children,
}: {
  query: { isPending: boolean; error: unknown; data: T | undefined };
  label: string;
  error: string;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) {
    return (
      <div className="grid gap-2" aria-busy="true">
        <span className="sr-only">{label}</span>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (query.error || query.data === undefined) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  return <>{children(query.data)}</>;
}

export function Empty({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="border-border/60 grid justify-items-center gap-2 rounded-lg border border-dashed p-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      {body ? <p className="text-muted-foreground text-sm">{body}</p> : null}
      {children}
    </div>
  );
}

function Pager({
  offset,
  total,
  pageSize,
  busy,
  onChange,
}: {
  offset: number;
  total: number;
  pageSize: number;
  busy: boolean;
  onChange: (offset: number) => void;
}) {
  if (total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-muted-foreground text-xs">
        {offset + 1}–{Math.min(offset + pageSize, total)} of {total}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={offset === 0 || busy} onClick={() => onChange(Math.max(0, offset - pageSize))}>
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={offset + pageSize >= total || busy} onClick={() => onChange(offset + pageSize)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
