'use client';

import { ArrowLeft, CalendarCheck, Clock, MapPin, User } from 'lucide-react';
import { useReducer, useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, ApiNetworkError } from '@/services/api-error';
import type { PublicCompany } from '@/services/public-booking.service';
import { PromotionCodeField } from '@/components/promotion-code-field';
import {
  useCreatePublicBooking,
  usePreviewPublicPromotion,
  usePublicCompany,
  usePublicEmployees,
} from '../api/use-public-booking';
import {
  brandStyle,
  formatDay,
  initialState,
  isoDay,
  reducer,
  stepsFor,
  wallTime,
  type CustomerFormValues,
  type Step,
} from '../model/booking-flow';
import { BookingConfirmation } from './booking-confirmation';
import {
  BranchStep,
  DetailsStep,
  EmployeeStep,
  ServiceStep,
  TimeStep,
  price,
  type FieldErrors,
} from './steps';

const TITLES: Record<Step, string> = {
  branch: 'Choose a location',
  service: 'Choose a service',
  employee: 'Choose who you’d like',
  time: 'Choose a date and time',
  details: 'Your details',
  confirmed: 'Booked',
};

/**
 * The customer-facing booking page for one company.
 *
 * Everything shown comes from the public API and everything submitted is
 * re-validated there; this component only walks the visitor through it and
 * explains the answers. Mobile first: one column, large touch targets, the
 * summary above the step on a phone and beside it on a wide screen.
 */
export function PublicBookingPage({ companySlug }: { companySlug: string }) {
  const company = usePublicCompany(companySlug);

  if (company.isPending) {
    return (
      <div aria-busy="true" className="grid gap-4">
        <span className="sr-only">Loading booking page…</span>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (company.error) {
    const missing = company.error instanceof ApiError && company.error.status === 404;
    return (
      <Alert variant={missing ? 'default' : 'destructive'} role="alert">
        <AlertTitle>{missing ? 'Booking page not found' : 'Couldn’t load this page'}</AlertTitle>
        <AlertDescription>
          {missing
            ? 'Check the link — this business may have moved or is not taking online bookings.'
            : 'Check your connection and try again.'}
        </AlertDescription>
      </Alert>
    );
  }

  return <Flow slug={companySlug} company={company.data} />;
}

function Flow({ slug, company }: { slug: string; company: PublicCompany }) {
  const singleBranch = company.branches.length === 1 ? company.branches[0]!.id : null;
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(singleBranch, isoDay()));
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const create = useCreatePublicBooking(slug);
  const previewPromotion = usePreviewPublicPromotion(slug);
  // A code is only sent for the basket it was previewed against; `promoRound`
  // remounts the field after the server turns a code down at booking time.
  const [promo, setPromo] = useState<{ basket: string; code: string } | null>(null);
  const [promoRound, setPromoRound] = useState(0);
  const basket = [state.branchId, state.service?.id, state.employeeId].join('|');
  const promotionCode = promo?.basket === basket ? promo.code : undefined;
  const employees = usePublicEmployees(
    slug,
    state.branchId,
    state.service?.requiresEmployee ? state.service.id : null,
  );

  const branch = company.branches.find((b) => b.id === state.branchId) ?? null;
  const employeeName =
    state.employeeId ? employees.data?.find((e) => e.id === state.employeeId)?.name ?? null : null;
  const steps = stepsFor(state, Boolean(singleBranch));
  const position = steps.indexOf(state.step);

  const submit = async (values: CustomerFormValues) => {
    if (!state.branchId || !state.service || !state.slot) return;
    setServerErrors({});
    setFailure(null);
    try {
      const confirmation = await create.mutateAsync({
        branchId: state.branchId,
        serviceId: state.service.id,
        ...(state.employeeId ? { employeeId: state.employeeId } : {}),
        // Exactly what the availability call returned — never rebuilt here.
        startsAt: state.slot.startAt,
        customer: {
          firstName: values.firstName,
          ...(values.lastName ? { lastName: values.lastName } : {}),
          phone: values.phone,
          ...(values.email ? { email: values.email } : {}),
        },
        ...(values.note ? { note: values.note } : {}),
        ...(promotionCode ? { promotionCode } : {}),
      });
      dispatch({ type: 'confirmed', confirmation });
    } catch (error) {
      handleFailure(error);
    }
  };

  const handleFailure = (error: unknown) => {
    if (error instanceof ApiError) {
      switch (error.code) {
        case 'SLOT_TAKEN':
        case 'SLOT_UNAVAILABLE':
          dispatch({
            type: 'slotLost',
            message: 'Someone booked that time just before you. Please pick another — the list is up to date.',
          });
          return;
        case 'VALIDATION_FAILED': {
          const next: FieldErrors = {};
          const issues = (error.details?.['issues'] ?? []) as Array<{ path?: string; message?: string }>;
          for (const issue of Array.isArray(issues) ? issues : []) {
            const field = issue.path?.replace(/^customer\./, '') as keyof FieldErrors | undefined;
            if (field && issue.message && ['firstName', 'lastName', 'phone', 'email', 'note'].includes(field)) {
              next[field] ??= issue.message;
            }
          }
          setServerErrors(next);
          if (Object.keys(next).length === 0) setFailure('Please check your details and try again.');
          return;
        }
        case 'ONLINE_BOOKING_UNAVAILABLE':
          setFailure(error.message);
          return;
        case 'PROMOTION_NOT_APPLICABLE':
          setPromo(null);
          setPromoRound((n) => n + 1);
          setFailure(
            `${error.message} The code has been removed — confirm again to book at the full price, or try another code.`,
          );
          return;
        case 'RESOURCE_NOT_FOUND':
        case 'TENANT_NOT_FOUND':
          setFailure('That option is no longer available online. Please start again.');
          return;
      }
      if (error.status === 429) {
        setFailure('Too many attempts. Please wait a minute and try again.');
        return;
      }
    }
    setFailure(
      error instanceof ApiNetworkError
        ? 'We couldn’t reach the booking service. Check your connection — you have not been booked.'
        : 'Something went wrong and you have not been booked. Please try again.',
    );
  };

  return (
    <div className="grid gap-6" style={brandStyle(company.branding?.primaryColor)}>
      <header className="grid gap-1">
        <p className="text-muted-foreground text-sm">Book online</p>
        <h1 className="text-2xl font-semibold tracking-tight">{company.name}</h1>
        {company.branding?.headline ? (
          <p className="text-muted-foreground">{company.branding.headline}</p>
        ) : null}
      </header>

      {state.step === 'confirmed' && state.confirmation ? (
        <BookingConfirmation
          confirmation={state.confirmation}
          locale={company.locale}
          onBookAnother={() => dispatch({ type: 'restart' })}
        />
      ) : (
        <div className="grid gap-6 md:grid-cols-[1fr_16rem] md:items-start">
          <section aria-labelledby="pb-step-title" className="grid gap-4">
            <div className="flex items-center gap-2">
              {position > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-2 size-11"
                  onClick={() => dispatch({ type: 'back' })}
                  aria-label="Back"
                >
                  <ArrowLeft aria-hidden className="size-4" />
                </Button>
              ) : null}
              <div className="grid">
                <span className="text-muted-foreground text-xs">
                  Step {position + 1} of {steps.length}
                </span>
                <h2 id="pb-step-title" className="text-lg font-semibold">
                  {TITLES[state.step]}
                </h2>
              </div>
            </div>
            <div
              className="bg-muted h-1 overflow-hidden rounded-full"
              role="progressbar"
              aria-valuemin={1}
              aria-valuemax={steps.length}
              aria-valuenow={position + 1}
              aria-label="Booking progress"
            >
              <div
                className="bg-primary h-full transition-all"
                style={{ width: `${((position + 1) / steps.length) * 100}%` }}
              />
            </div>

            {failure ? (
              <Alert variant="destructive" role="alert">
                <AlertTitle>Not booked</AlertTitle>
                <AlertDescription>{failure}</AlertDescription>
              </Alert>
            ) : null}

            {state.step === 'branch' ? (
              <BranchStep
                branches={company.branches}
                onSelect={(branchId) => dispatch({ type: 'branch', branchId })}
              />
            ) : null}

            {state.step === 'service' && state.branchId ? (
              <ServiceStep
                slug={slug}
                branchId={state.branchId}
                selectedId={state.service?.id ?? null}
                onSelect={(service) => dispatch({ type: 'service', service })}
              />
            ) : null}

            {state.step === 'employee' && state.branchId && state.service ? (
              <EmployeeStep
                slug={slug}
                branchId={state.branchId}
                serviceId={state.service.id}
                onSelect={(employeeId) => dispatch({ type: 'employee', employeeId })}
              />
            ) : null}

            {state.step === 'time' && state.branchId && state.service && state.date ? (
              <TimeStep
                slug={slug}
                branchId={state.branchId}
                serviceId={state.service.id}
                employeeId={state.employeeId}
                date={state.date}
                notice={state.notice}
                locale={company.locale}
                onDate={(date) => dispatch({ type: 'date', date })}
                onSelect={(slot) => {
                  setFailure(null);
                  dispatch({ type: 'slot', slot });
                }}
              />
            ) : null}

            {state.step === 'details' && state.branchId && state.service ? (
              <PromotionCodeField
                key={`${basket}#${promoRound}`}
                id="pb-promotion-code"
                disabled={create.isPending}
                validate={(code) =>
                  previewPromotion.mutateAsync({
                    code,
                    branchId: state.branchId!,
                    serviceId: state.service!.id,
                    ...(state.employeeId ? { employeeId: state.employeeId } : {}),
                  })
                }
                onApplied={(code) => setPromo(code ? { basket, code } : null)}
              />
            ) : null}

            {state.step === 'details' ? (
              <DetailsStep
                submitting={create.isPending}
                serverErrors={serverErrors}
                onSubmit={(values) => void submit(values)}
              />
            ) : null}
          </section>

          <aside
            aria-label="Your booking"
            className="bg-muted/40 order-first grid gap-2 rounded-xl p-4 text-sm md:order-none md:sticky md:top-6"
          >
            <p className="font-medium">Your booking</p>
            <Line icon={<MapPin aria-hidden className="size-4" />} value={branch?.name} placeholder="Location" />
            <Line
              icon={<CalendarCheck aria-hidden className="size-4" />}
              value={
                state.service
                  ? `${state.service.name} · ${price(state.service.priceMinor, state.service.currencyCode)}`
                  : null
              }
              placeholder="Service"
            />
            {state.service?.requiresEmployee !== false ? (
              <Line
                icon={<User aria-hidden className="size-4" />}
                value={state.employeeChosen ? (employeeName ?? 'Anyone available') : null}
                placeholder="Staff"
              />
            ) : null}
            <Line
              icon={<Clock aria-hidden className="size-4" />}
              value={
                state.slot && state.date
                  ? `${formatDay(state.date, company.locale)} · ${wallTime(state.slot.startAt)}–${wallTime(state.slot.endAt)}`
                  : state.service
                    ? `${state.service.durationMin} min`
                    : null
              }
              placeholder="Date & time"
            />
          </aside>
        </div>
      )}
    </div>
  );
}

function Line(props: { icon: ReactNode; value: string | null | undefined; placeholder: string }) {
  return (
    <p className={`flex items-center gap-2 ${props.value ? '' : 'text-muted-foreground'}`}>
      <span className="text-muted-foreground shrink-0">{props.icon}</span>
      <span className="min-w-0 truncate">{props.value ?? props.placeholder}</span>
    </p>
  );
}
