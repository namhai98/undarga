'use client';

import { formatMoney } from '@undarga/shared';
import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { currencyFormat } from '@/lib/currency';
import { ApiError } from '@/services/api-error';
import { useCustomer, useCustomerAppointments, useDeleteCustomer } from '../api/use-customers';
import { CustomerForm } from './customer-form';

/**
 * Everything one company knows about one person.
 *
 * The statistics on the right are projections of the appointment and payment
 * tables, not editable fields — the API refuses them in a request body, so
 * they are rendered as facts rather than inputs.
 */
/**
 * `children` are extra sections from other features (gift cards), rendered
 * only once the customer has loaded. A slot rather than an import keeps this
 * feature from depending on the ones that hang off it.
 */
export function CustomerDetail({
  customerId,
  children,
}: {
  customerId: string;
  children?: ReactNode;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canWrite = useCan('customer:write');
  const canReadHistory = useCan('appointment:read:any');

  const customer = useCustomer(customerId);
  const remove = useDeleteCustomer();

  if (customer.isPending) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only">Loading the customer…</span>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (customer.error || !customer.data) {
    return (
      <div className="grid gap-4">
        <BackLink />
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not load this customer</AlertTitle>
          <AlertDescription>
            They may have been deactivated, or belong to another company.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const detail = customer.data;

  if (editing) {
    return (
      <CustomerForm
        customerId={customerId}
        onDone={() => setEditing(false)}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const handleDelete = async () => {
    setError(null);
    try {
      await remove.mutateAsync(customerId);
      router.push('/customers');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not deactivate this customer.');
    }
  };

  return (
    <div className="grid gap-6">
      <BackLink />

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{detail.fullName}</h1>
            {detail.status !== 'ACTIVE' ? (
              <Badge variant="secondary">{detail.status.toLowerCase()}</Badge>
            ) : null}
            {detail.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
          <p className="text-muted-foreground text-sm">
            {[detail.phone, detail.email].filter(Boolean).join(' · ') || 'No contact details'}
          </p>
        </div>

        {canWrite ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={remove.isPending}
              onClick={() => setConfirmingDelete(true)}
            >
              Deactivate
            </Button>
          </div>
        ) : null}
      </header>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not deactivate</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {confirmingDelete ? (
        <Alert role="alert">
          <AlertTitle>Deactivate {detail.fullName}?</AlertTitle>
          <AlertDescription className="grid gap-3">
            <p>
              Their appointment and payment history stays intact — the record is hidden, not erased.
              Their phone number and email become available for a new customer.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => void handleDelete()}
              >
                {remove.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                Deactivate
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmingDelete(false)}>
                Keep
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Detail label="Phone" value={detail.phone} />
              <Detail label="Email" value={detail.email} />
              <Detail label="Address" value={detail.address} />
              <Detail label="Birthday" value={detail.birthDate} />
              <Detail label="Usual staff member" value={detail.preferredEmployeeName} />
              <Detail
                label="Customer since"
                value={new Date(detail.createdAt).toLocaleDateString()}
              />
            </dl>

            {detail.notes ? (
              <div className="border-border/60 mt-4 border-t pt-4">
                <dt className="text-muted-foreground text-xs">Notes</dt>
                <dd className="mt-1 text-sm whitespace-pre-wrap">{detail.notes}</dd>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>Maintained by the booking and payment flows.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3">
              <Detail label="Visits" value={String(detail.totalVisits)} />
              <Detail label="No-shows" value={String(detail.totalNoShows)} />
              <Detail
                label="Lifetime spend"
                value={formatMoney(
                  { amountMinor: detail.totalSpentMinor, currencyCode: 'MNT' },
                  currencyFormat('MNT'),
                )}
              />
              <Detail
                label="Last visit"
                value={
                  detail.lastVisitAt ? new Date(detail.lastVisitAt).toLocaleDateString() : 'Never'
                }
              />
            </dl>
          </CardContent>
        </Card>
      </div>

      {children}

      {canReadHistory ? (
        <AppointmentHistory customerId={customerId} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Appointments</CardTitle>
            <CardDescription>
              {/* Seeing a customer is a different decision from seeing everything
                  they have ever booked. The query is not fired at all rather than
                  fired and 403'd. */}
              You do not have permission to see this customer’s booking history.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}

function AppointmentHistory({ customerId }: { customerId: string }) {
  const appointments = useCustomerAppointments(customerId);
  const items = appointments.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appointments</CardTitle>
        <CardDescription>
          {appointments.isPending
            ? 'Loading…'
            : `${appointments.data?.total ?? 0} in total, newest first.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {appointments.error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Could not load the history</AlertTitle>
            <AlertDescription>Please try again.</AlertDescription>
          </Alert>
        ) : null}

        {appointments.isPending ? (
          <div className="grid gap-2" aria-busy="true">
            <span className="sr-only">Loading appointments…</span>
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : null}

        {!appointments.isPending && items.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing booked yet.</p>
        ) : null}

        {items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    When
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Reference
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Services
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Branch
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Total
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((appointment) => (
                  <tr key={appointment.id} className="border-border/40 border-b last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {new Date(appointment.startsAt).toLocaleString()}
                    </td>
                    <td className="text-muted-foreground py-2 pr-3 font-mono text-xs">
                      {appointment.appointmentNumber}
                    </td>
                    <td className="py-2 pr-3">
                      {appointment.services.length > 0
                        ? appointment.services.map((s) => s.name).join(', ')
                        : '—'}
                    </td>
                    <td className="text-muted-foreground py-2 pr-3">{appointment.branchName}</td>
                    <td className="py-2 pr-3 tabular-nums">
                      {formatMoney(
                        {
                          amountMinor: appointment.totalMinor,
                          currencyCode: appointment.currencyCode,
                        },
                        currencyFormat(appointment.currencyCode),
                      )}
                    </td>
                    <td className="py-2">
                      <Badge variant={appointment.status === 'COMPLETED' ? 'default' : 'secondary'}>
                        {appointment.status.toLowerCase().replace(/_/g, ' ')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BackLink() {
  return (
    <Link
      href="/customers"
      className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} -ml-2 w-fit`}
    >
      <ArrowLeft aria-hidden className="size-4" />
      All customers
    </Link>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{value ?? '—'}</dd>
    </div>
  );
}
