'use client';

import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/features/auth';
import { fieldErrorsFromApi } from '@/hooks/use-zod-form';
import { ApiError } from '@/services/api-error';
import type { OnboardingStatusView } from '@/services/onboarding.service';
import {
  useCompleteOnboarding,
  useCreateOnboardingCompany,
  useOnboardingSetup,
  useOnboardingStatus,
} from '../api/use-onboarding';
import {
  WIZARD_STEPS,
  checkBranch,
  checkBusiness,
  checkCompany,
  checkServices,
  createPayload,
  emptyDraft,
  servicesPayload,
  setupPayload,
  type Draft,
  type ServiceRow,
  type StepErrors,
  type WizardStep,
} from '../model/draft';
import { BranchStep, BusinessStep, CompanyStep, Pending, ServicesStep } from './steps';
import { useT } from '@/lib/i18n';

/** Where a server-side field error belongs: which step, which input. */
const API_FIELDS: Record<string, [WizardStep, string]> = {
  slug: ['company', 'slug'],
  'company.slug': ['company', 'slug'],
  'company.displayName': ['company', 'displayName'],
  'company.legalName': ['company', 'legalName'],
  'branch.name': ['branch', 'branchName'],
  'branch.code': ['branch', 'branchName'],
  'branch.timezoneName': ['branch', 'timezoneName'],
  defaultTimezoneName: ['branch', 'timezoneName'],
  'branch.phone': ['branch', 'branchPhone'],
  'branch.addressLine1': ['branch', 'addressLine1'],
  'branch.addressLine2': ['branch', 'addressLine2'],
  'branch.city': ['branch', 'city'],
  currencyCode: ['business', 'currencyCode'],
  'business.currencyCode': ['business', 'currencyCode'],
  'business.contactEmail': ['business', 'contactEmail'],
  'business.contactPhone': ['business', 'contactPhone'],
  'business.registrationNumber': ['business', 'registrationNumber'],
  'business.taxNumber': ['business', 'taxNumber'],
};

type Mode = 'create' | 'setup';

interface Finished {
  companyName: string;
  services: number;
}

/**
 * The onboarding wizard (docs/ONBOARDING.md).
 *
 * Steps 1-3 are held in memory and sent together, because the API creates them
 * in one transaction: there is never a half-made company to come back to. Step
 * 4 runs against the company that now exists, so leaving at that point and
 * returning later resumes there — the shell sends the owner back.
 *
 *   create   no company yet (or `?new=1`): POST /onboarding/company, then
 *            switch into it.
 *   setup    an operator-provisioned company that has not been set up: the
 *            identifier is fixed, steps 1-3 go to /setup.
 */
export function OnboardingWizard({ createNew = false }: { createNew?: boolean }) {
  const t = useT();
  const session = useSession();
  const ready = session.status === 'authenticated' && !session.isLoadingCompany;
  const status = useOnboardingStatus(session.activeCompanyId, ready);

  // Where to start is decided ONCE, from the first status answer, and then
  // kept: this wizard's own writes switch the active company and refetch the
  // status, and that must neither restart it nor unmount it mid-flow. Set
  // during render (React's "adjust state on a prop change" pattern), not in an
  // effect, so the first paint is already the right step.
  const [start, setStart] = useState<Start | null>(null);
  if (start === null && status.data) setStart(startFrom(status.data, createNew));

  if (start === null) {
    if (status.error) {
      return (
        <div className="mx-auto w-full max-w-2xl">
          <Alert variant="destructive" role="alert">
            <AlertTitle>{t('Could not load onboarding')}</AlertTitle>
            <AlertDescription>{t('Reload the page to try again.')}</AlertDescription>
          </Alert>
        </div>
      );
    }
    return (
      <div className="mx-auto grid w-full max-w-2xl gap-3" aria-busy="true">
        <span className="sr-only">{t('Loading onboarding…')}</span>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (start.kind === 'already-done') {
    return (
      <Notice
        title={t('Your company is set up')}
        body={t('{companyName} has finished onboarding.', { companyName: start.companyName })}
      >
        <Link href="/dashboard" className={buttonVariants({ size: 'sm' })}>
          {t('Go to dashboard')}
        </Link>
        <Link
          href="/onboarding?new=1"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('Create another company')}
        </Link>
      </Notice>
    );
  }

  if (start.kind === 'not-allowed') {
    return (
      <Notice
        title={t('Setup is not finished yet')}
        body="The owner or an administrator of this company needs to finish setting it up."
      >
        <Link href="/dashboard" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {t('Continue to dashboard')}
        </Link>
      </Notice>
    );
  }

  return <WizardFlow start={start} />;
}

type Target = { id: string; name: string; currencyCode: string };

type Start =
  | { kind: 'flow'; mode: Mode; step: WizardStep; draft: Draft; target: Target | null }
  | { kind: 'already-done'; companyName: string }
  | { kind: 'not-allowed' };

function startFrom(data: OnboardingStatusView, createNew: boolean): Start {
  if (createNew || !data.company) {
    return { kind: 'flow', mode: 'create', step: 'company', draft: emptyDraft(), target: null };
  }
  if (data.status === 'COMPLETED') {
    return { kind: 'already-done', companyName: data.company.displayName };
  }
  if (!data.canManage) return { kind: 'not-allowed' };

  const target = {
    id: data.company.id,
    name: data.company.displayName,
    currencyCode: data.company.currencyCode,
  };
  if (data.status === 'IN_PROGRESS') {
    return { kind: 'flow', mode: 'setup', step: 'services', draft: emptyDraft(), target };
  }

  const draft = emptyDraft({ displayName: data.company.displayName, slug: data.company.slug });
  draft.branch.timezoneName = data.company.defaultTimezoneName;
  draft.business.currencyCode = data.company.currencyCode;
  return { kind: 'flow', mode: 'setup', step: 'company', draft, target };
}

function WizardFlow({ start }: { start: Extract<Start, { kind: 'flow' }> }) {
  const t = useT();
  const router = useRouter();

  const [mode] = useState<Mode>(start.mode);
  const [step, setStep] = useState<WizardStep>(start.step);
  const [draft, setDraft] = useState<Draft>(start.draft);
  const [errors, setErrors] = useState<StepErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(start.target);
  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [finished, setFinished] = useState<Finished | null>(null);
  const keys = useRef(0);
  const nextKey = () => ++keys.current;

  const create = useCreateOnboardingCompany();
  const setup = useOnboardingSetup(target?.id ?? '');
  const complete = useCompleteOnboarding(target?.id ?? '');

  // Step 5 says so, then takes the owner to their dashboard.
  useEffect(() => {
    if (step !== 'complete') return;
    const timer = setTimeout(() => router.replace('/dashboard'), 4000);
    return () => clearTimeout(timer);
  }, [step, router]);

  const update = (change: (d: Draft) => Draft) => setDraft((d) => change(d));

  const go = (next: WizardStep) => {
    setErrors({});
    setFormError(null);
    setStep(next);
  };

  /** Put server field errors on their step; anything unmapped is form-level. */
  const showApiError = (error: unknown, fallback: string) => {
    if (!(error instanceof ApiError)) {
      setFormError(fallback);
      return;
    }
    const fields: Array<[string, string]> = [];
    if (error.code === 'VALIDATION_FAILED') {
      fields.push(...Object.entries(fieldErrorsFromApi(error.details)));
    } else if (error.code === 'CONFLICT' && typeof error.details?.field === 'string') {
      fields.push([error.details.field, error.message]);
    }
    const mapped = fields.filter(([path]) => API_FIELDS[path]);
    if (mapped.length > 0) {
      const [firstStep] = API_FIELDS[mapped[0]![0]]!;
      setStep(firstStep);
      setErrors(
        Object.fromEntries(mapped.map(([path, message]) => [API_FIELDS[path]![1], message])),
      );
      setFormError(null);
      return;
    }
    setFormError(error.message || fallback);
  };

  const submitSetup = async () => {
    setFormError(null);
    try {
      if (mode === 'create') {
        const { created } = await create.mutateAsync(createPayload(draft));
        setTarget({
          id: created.company.id,
          name: created.company.displayName,
          currencyCode: created.company.currencyCode,
        });
      } else {
        await setup.mutateAsync(setupPayload(draft));
        setTarget((item) =>
          item
            ? {
                ...item,
                name: draft.company.displayName.trim(),
                currencyCode: draft.business.currencyCode,
              }
            : item,
        );
      }
      go('services');
    } catch (error) {
      showApiError(error, 'Could not save your company. Please try again.');
    }
  };

  const finish = async (withServices: boolean) => {
    if (!target) return;
    const list = withServices ? rows : [];
    if (withServices) {
      const found = checkServices(list, target.currencyCode);
      setErrors(found);
      if (Object.keys(found).length > 0) return;
    }
    setFormError(null);
    try {
      await complete.mutateAsync(servicesPayload(list, target.currencyCode));
      setFinished({ companyName: target.name, services: list.length });
      go('complete');
    } catch (error) {
      showApiError(error, 'Could not finish onboarding. Please try again.');
    }
  };

  const next = () => {
    const found =
      step === 'company'
        ? checkCompany(draft, mode === 'create')
        : step === 'branch'
          ? checkBranch(draft)
          : checkBusiness(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (step === 'company') go('branch');
    else if (step === 'branch') go('business');
    else void submitSetup();
  };

  // -------------------------------------------------------------------------

  const index = WIZARD_STEPS.findIndex((s) => s.key === step);
  const busy = create.isPending || setup.isPending || complete.isPending;

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-6">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">
          {mode === 'setup' || target
            ? t('Set up {value}', { value: target?.name ?? t('your company') })
            : t('Set up your company')}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t(
            'A few details and you are ready to take bookings. Your free trial starts when the company is created.',
          )}
        </p>
      </header>

      <Stepper current={index} />

      {step === 'complete' && finished ? (
        <Card>
          <CardHeader className="items-center text-center">
            <CheckCircle2 aria-hidden className="size-10 text-emerald-600" />
            <CardTitle>
              {t('{companyName} is ready', { companyName: finished.companyName })}
            </CardTitle>
            <CardDescription>
              {finished.services > 0
                ? finished.services === 1
                  ? t('Your branch and 1 service are set up.')
                  : t('Your branch and {services} services are set up.', {
                      services: finished.services,
                    })
                : t(
                    'Your branch is set up. Add services from the Services page whenever you are ready.',
                  )}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid justify-items-center gap-2">
            <Button onClick={() => router.replace('/dashboard')}>{t('Go to dashboard')}</Button>
            <p className="text-muted-foreground text-xs" aria-live="polite">
              {t('Taking you to your dashboard…')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{STEP_TITLES[step]}</CardTitle>
            <CardDescription>{stepDescription(step, mode)}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            {formError ? (
              <Alert variant="destructive" role="alert">
                <AlertTitle>{t('Something went wrong')}</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}

            {step === 'company' ? (
              <CompanyStep
                draft={draft}
                update={update}
                errors={errors}
                slugEditable={mode === 'create'}
              />
            ) : step === 'branch' ? (
              <BranchStep draft={draft} update={update} errors={errors} />
            ) : step === 'business' ? (
              <BusinessStep draft={draft} update={update} errors={errors} />
            ) : (
              <ServicesStep
                rows={rows}
                setRows={setRows}
                errors={errors}
                currencyCode={target?.currencyCode ?? draft.business.currencyCode}
                nextKey={nextKey}
              />
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
              {step === 'branch' || step === 'business' ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => go(step === 'branch' ? 'company' : 'branch')}
                >
                  {t('Back')}
                </Button>
              ) : (
                <span />
              )}

              {step === 'services' ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void finish(false)}
                  >
                    {t('Skip for now')}
                  </Button>
                  <Button
                    type="button"
                    disabled={busy || rows.length === 0}
                    onClick={() => void finish(true)}
                  >
                    {complete.isPending ? (
                      <Pending>{t('Finishing…')}</Pending>
                    ) : (
                      t('Save services and finish')
                    )}
                  </Button>
                </div>
              ) : (
                <Button type="button" disabled={busy} onClick={next}>
                  {step === 'business' ? (
                    busy ? (
                      <Pending>{mode === 'create' ? t('Creating…') : t('Saving…')}</Pending>
                    ) : mode === 'create' ? (
                      t('Create company')
                    ) : (
                      t('Save and continue')
                    )
                  ) : (
                    t('Continue')
                  )}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const STEP_TITLES: Record<WizardStep, string> = {
  company: 'Your company',
  branch: 'Your first branch',
  business: 'Business settings',
  services: 'Services',
  complete: 'Done',
};

function stepDescription(step: WizardStep, mode: Mode): string {
  switch (step) {
    case 'company':
      return mode === 'create'
        ? 'The name customers see, and the identifier used in your booking link.'
        : 'Check the name customers will see.';
    case 'branch':
      return 'Where appointments happen. You can add more branches later.';
    case 'business':
      return mode === 'create'
        ? 'Your currency and contact details. Creating the company starts your free trial.'
        : 'Your currency and contact details.';
    case 'services':
      return 'What customers can book. Optional — you can skip this and add services later.';
    default:
      return '';
  }
}

function Stepper({ current }: { current: number }) {
  const t = useT();
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-2" aria-label={t('Onboarding progress')}>
      {WIZARD_STEPS.map((s, i) => (
        <li
          key={s.key}
          aria-current={i === current ? 'step' : undefined}
          className={`flex items-center gap-2 text-sm ${
            i === current
              ? 'font-medium'
              : i < current
                ? 'text-foreground'
                : 'text-muted-foreground'
          }`}
        >
          <span
            className={`flex size-6 items-center justify-center rounded-full border text-xs ${
              i < current
                ? 'bg-primary border-primary text-primary-foreground'
                : i === current
                  ? 'border-primary'
                  : 'border-border'
            }`}
          >
            {i < current ? '✓' : i + 1}
          </span>
          {s.label}
        </li>
      ))}
    </ol>
  );
}

function Notice({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{body}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">{children}</CardContent>
      </Card>
    </div>
  );
}
