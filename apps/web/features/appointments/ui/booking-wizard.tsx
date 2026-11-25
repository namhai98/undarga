'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PromotionCodeField } from '@/components/promotion-code-field';
import { useCan } from '@/features/auth';
import { useBookableServices } from '@/features/availability';
import { useValidatePromotion } from '@/features/billing';
import { useBranches } from '@/features/branches';
import { useCustomers } from '@/features/customers';
import { useEmployees } from '@/features/employees';
import type { AvailabilitySlot } from '@/services/availability.service';
import { useCreateAppointment } from '../api/use-appointments';
import { bookingErrorMessage, localTime, todayIso } from '../model/appointment-display';
import { RecurringBooking } from './recurring-booking';
import { SlotPicker } from './slot-picker';
import { useT } from '@/lib/i18n';

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/**
 * Book an appointment:
 *
 *   branch → service → date → time → employee / resource → customer → confirm
 *
 * Each step unlocks the next. The times come from the availability engine and
 * the chosen `startAt` is sent back verbatim; the server re-validates it inside
 * a locked transaction, so a stale screen can lose a race but cannot double
 * book. Changing an earlier step clears everything after it.
 */
export function BookingWizard() {
  const t = useT();
  const router = useRouter();
  const canBook = useCan('appointment:write');

  const branches = useBranches();
  const services = useBookableServices();
  const employees = useEmployees({ status: 'ACTIVE', limit: 100 });

  const [branchId, setBranchId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState(todayIso(1));
  const [slot, setSlot] = useState<AvailabilitySlot | null>(null);
  const [employeeId, setEmployeeId] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerId, setCustomerId] = useState('');
  // Kept separately: the search box may move on and drop them from the list.
  const [customerName, setCustomerName] = useState('');
  const [customerNote, setCustomerNote] = useState('');
  const [internalNote, setInternalNote] = useState('');
  // A code is only sent for the basket it was previewed against.
  const [promo, setPromo] = useState<{ basket: string; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Repeat as a recurring series instead of one appointment.
  const [repeat, setRepeat] = useState(false);

  const customers = useCustomers({ search: customerSearch || undefined, limit: 10 });
  const create = useCreateAppointment();
  const validatePromotion = useValidatePromotion();

  const service = services.data?.items.find((s) => s.id === serviceId) ?? null;
  const branch = branches.data?.items.find((b) => b.id === branchId) ?? null;
  const basket = [branchId, serviceId, employeeId, customerId].join('|');
  const promotionCode = promo?.basket === basket ? promo.code : undefined;
  const nameOf = (id: string) =>
    employees.data?.items.find((e) => e.id === id)?.displayName ?? 'Staff member';

  /** Clear every step after the one that changed. */
  const resetFrom = (step: 'service' | 'date' | 'time') => {
    if (step === 'service') setServiceId('');
    if (step === 'service' || step === 'date') setSlot(null);
    setEmployeeId('');
    setError(null);
  };

  if (!canBook) {
    return (
      <Alert role="status">
        <AlertTitle>{t('Not available')}</AlertTitle>
        <AlertDescription>{t('You do not have permission to book appointments.')}</AlertDescription>
      </Alert>
    );
  }

  const submit = async () => {
    if (!slot || !customerId) return;
    setError(null);
    try {
      const created = await create.mutateAsync({
        branchId,
        serviceId,
        customerId,
        startsAt: slot.startAt,
        ...(employeeId ? { employeeId } : {}),
        customerNote: customerNote.trim() || null,
        internalNote: internalNote.trim() || null,
        ...(promotionCode ? { promotionCode } : {}),
      });
      router.push(`/appointments/${created.id}`);
    } catch (caught) {
      setError(bookingErrorMessage(caught, 'Could not book this appointment.', t));
      // The slot list was invalidated; make the user pick again rather than
      // resubmitting a time that is gone.
      setSlot(null);
      setEmployeeId('');
    }
  };

  return (
    <section className="grid gap-4">
      <Link
        href="/appointments"
        className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} -ml-2 w-fit`}
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t('All appointments')}
      </Link>
      <h2 className="text-lg font-semibold">{t('New appointment')}</h2>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('Not booked')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Step n={1} title={t('Where and what')}>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="book-branch">{t('Branch')}</Label>
            <select
              id="book-branch"
              className={selectClass}
              value={branchId}
              onChange={(e) => {
                setBranchId(e.target.value);
                resetFrom('service');
              }}
            >
              <option value="">{t('Select…')}</option>
              {(branches.data?.items ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="book-service">{t('Service')}</Label>
            <select
              id="book-service"
              className={selectClass}
              value={serviceId}
              disabled={!branchId}
              onChange={(e) => {
                setServiceId(e.target.value);
                resetFrom('date');
              }}
            >
              <option value="">{t('Select…')}</option>
              {(services.data?.items ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.durationMin}m
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="book-date">{t('Date')}</Label>
            <input
              id="book-date"
              type="date"
              className={selectClass}
              value={date}
              min={todayIso()}
              disabled={!serviceId}
              onChange={(e) => {
                setDate(e.target.value);
                resetFrom('date');
              }}
            />
          </div>
        </div>
      </Step>

      <Step n={2} title={t('Time')} muted={!serviceId}>
        <SlotPicker
          branchId={branchId}
          serviceId={serviceId}
          date={date}
          selected={slot?.startAt ?? null}
          onSelect={(picked) => {
            setSlot(picked);
            setEmployeeId('');
            setError(null);
          }}
        />
      </Step>

      <Step n={3} title={t('With whom')} muted={!slot}>
        {!slot ? (
          <p className="text-muted-foreground text-sm">{t('Pick a time first.')}</p>
        ) : (
          <div className="grid gap-3">
            {service?.requiresEmployee && slot.employeeIds.length > 0 ? (
              <div className="grid gap-1.5 sm:max-w-xs">
                <Label htmlFor="book-employee">{t('Employee')}</Label>
                <select
                  id="book-employee"
                  className={selectClass}
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                >
                  <option value="">
                    {t('Any available ({length})', { length: slot.employeeIds.length })}
                  </option>
                  {slot.employeeIds.map((id) => (
                    <option key={id} value={id}>
                      {nameOf(id)}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">{t('No specific employee needed.')}</p>
            )}
            {service?.requiresResource ? (
              <p className="text-muted-foreground text-sm">
                {t('Room / equipment: assigned automatically ({length} available).', {
                  length: slot.resourceIds.length,
                })}
              </p>
            ) : null}
          </div>
        )}
      </Step>

      <Step n={4} title={t('Customer')} muted={!slot}>
        <div className="grid gap-3">
          <div className="grid gap-1.5 sm:max-w-sm">
            <Label htmlFor="book-customer-search">{t('Find customer')}</Label>
            <Input
              id="book-customer-search"
              value={customerSearch}
              placeholder={t('Name, phone or email')}
              disabled={!slot}
              onChange={(e) => setCustomerSearch(e.target.value)}
            />
          </div>
          {slot ? (
            <div role="radiogroup" aria-label={t('Customers')} className="grid gap-1">
              {(customers.data?.items ?? []).map((c) => (
                <label
                  key={c.id}
                  className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm"
                >
                  <input
                    type="radio"
                    name="book-customer"
                    checked={customerId === c.id}
                    onChange={() => {
                      setCustomerId(c.id);
                      setCustomerName(c.fullName);
                    }}
                  />
                  <span className="font-medium">{c.fullName}</span>
                  <span className="text-muted-foreground">{c.phone ?? c.email ?? ''}</span>
                </label>
              ))}
              {customers.data && customers.data.items.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {t('Nobody matches.')}{' '}
                  <Link href="/customers" className="underline">
                    {t('Add a customer first')}
                  </Link>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </Step>

      <Step n={5} title={t('Confirm')} muted={!slot || !customerId}>
        {slot && customerId ? (
          <div className="grid gap-3">
            <dl className="grid gap-1 text-sm sm:grid-cols-2">
              <Summary label={t('Branch')} value={branch?.name} />
              <Summary label={t('Service')} value={service?.name} />
              <Summary
                label={t('When')}
                value={`${date} ${localTime(slot.startAt)}–${localTime(slot.endAt)}`}
              />
              <Summary
                label={t('Employee')}
                value={employeeId ? nameOf(employeeId) : 'Any available'}
              />
              <Summary label={t('Customer')} value={customerName} />
            </dl>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="book-customer-note">{t('Note from customer')}</Label>
                <Input
                  id="book-customer-note"
                  value={customerNote}
                  maxLength={2000}
                  onChange={(e) => setCustomerNote(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="book-internal-note">{t('Internal note')}</Label>
                <Input
                  id="book-internal-note"
                  value={internalNote}
                  maxLength={2000}
                  onChange={(e) => setInternalNote(e.target.value)}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={repeat}
                onChange={(e) => setRepeat(e.target.checked)}
              />
              {t('Repeat this appointment (recurring)')}
            </label>
            {repeat ? (
              <RecurringBooking
                key={basket + slot.startAt}
                startDate={date}
                base={{
                  branchId,
                  serviceId,
                  customerId,
                  startsAt: slot.startAt,
                  ...(employeeId ? { employeeId } : {}),
                  customerNote: customerNote.trim() || null,
                  internalNote: internalNote.trim() || null,
                }}
                onBooked={({ firstAppointmentId }) =>
                  router.push(
                    firstAppointmentId ? `/appointments/${firstAppointmentId}` : '/appointments',
                  )
                }
              />
            ) : (
              <>
                {/* Any booker may check a code: the endpoint accepts appointment:write. */}
                <div className="max-w-md">
                  <PromotionCodeField
                    key={basket}
                    id="book-promotion-code"
                    disabled={create.isPending}
                    validate={(code) =>
                      validatePromotion.mutateAsync({
                        code,
                        branchId,
                        serviceId,
                        customerId,
                        ...(employeeId ? { employeeId } : {}),
                      })
                    }
                    onApplied={(code) => setPromo(code ? { basket, code } : null)}
                  />
                </div>
                <div>
                  <Button disabled={create.isPending} onClick={() => void submit()}>
                    {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                    {t('Book appointment')}
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">{t('Choose a time and a customer.')}</p>
        )}
      </Step>
    </section>
  );
}

function Step(props: { n: number; title: string; muted?: boolean; children: ReactNode }) {
  return (
    <Card className={props.muted ? 'opacity-60' : undefined}>
      <CardHeader>
        <CardTitle className="text-base">
          {props.n}. {props.title}
        </CardTitle>
      </CardHeader>
      <CardContent>{props.children}</CardContent>
    </Card>
  );
}

function Summary({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted-foreground w-24 shrink-0">{label}</dt>
      <dd className="font-medium">{value ?? '—'}</dd>
    </div>
  );
}
