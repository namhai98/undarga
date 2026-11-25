import { defaultTimezone, timezoneOptions } from '@/lib/timezones';
import { decimalToMinorString } from '@undarga/shared';
import { z } from 'zod';
import { currencyFormat } from '@/lib/currency';
import type {
  OnboardingHoursDay,
  CreateOnboardingCompanyInput,
  InitialServiceInput,
  OnboardingSetupInput,
} from '@/services/onboarding.service';

/**
 * The wizard's state, and the rules each step is checked against before the
 * user may move on.
 *
 * The rules mirror the API's (`apps/api/src/onboarding/dto`) so a mistake is
 * caught on the step that made it rather than three steps later when the
 * request is finally sent. The API still decides: its errors are shown too.
 */

export const WIZARD_STEPS = [
  { key: 'company', label: 'Company' },
  { key: 'branch', label: 'Branch' },
  { key: 'business', label: 'Business' },
  { key: 'services', label: 'Services' },
  { key: 'complete', label: 'Done' },
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number]['key'];

/** The currencies the platform is set up for (the `currency` table). */
export const CURRENCIES = ['MNT', 'USD', 'EUR', 'GBP', 'CNY', 'JPY', 'KRW', 'RUB'] as const;

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
/** Monday first, the way a week is read on a schedule. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface HoursRow {
  dayOfWeek: number;
  open: boolean;
  opensAt: string;
  closesAt: string;
}

export interface ServiceRow {
  key: number;
  name: string;
  category: string;
  durationMin: string;
  price: string;
  isActive: boolean;
}

export interface Draft {
  company: { displayName: string; legalName: string; slug: string; slugEdited: boolean };
  branch: {
    name: string;
    timezoneName: string;
    phone: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
  };
  business: {
    currencyCode: string;
    contactEmail: string;
    contactPhone: string;
    registrationNumber: string;
    taxNumber: string;
    setHours: boolean;
    hours: HoursRow[];
  };
}

export { defaultTimezone, timezoneOptions };

export function emptyDraft(prefill?: { displayName?: string; slug?: string }): Draft {
  return {
    company: {
      displayName: prefill?.displayName ?? '',
      legalName: '',
      slug: prefill?.slug ?? '',
      slugEdited: Boolean(prefill?.slug),
    },
    branch: {
      name: 'Main branch',
      timezoneName: defaultTimezone(),
      phone: '',
      addressLine1: '',
      addressLine2: '',
      city: '',
    },
    business: {
      currencyCode: 'MNT',
      contactEmail: '',
      contactPhone: '',
      registrationNumber: '',
      taxNumber: '',
      setHours: false,
      hours: WEEK_ORDER.map((dayOfWeek) => ({
        dayOfWeek,
        open: dayOfWeek !== 0,
        opensAt: dayOfWeek === 6 ? '10:00' : '09:00',
        closesAt: dayOfWeek === 6 ? '16:00' : '18:00',
      })),
    },
  };
}

/** "Nomin Spa & Salon" -> "nomin-spa-salon". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

// ---------------------------------------------------------------------------
// Per-step checks. Each returns field errors keyed by input id; empty = valid.
// ---------------------------------------------------------------------------

const slugRule = z
  .string()
  .min(3, 'At least 3 characters.')
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'Lowercase letters, digits and hyphens; no hyphen at either end.',
  );

const email = z.string().trim().email('Enter a valid email address.').max(320);
const hhmm = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export type StepErrors = Record<string, string>;

export function checkCompany(draft: Draft, slugEditable: boolean): StepErrors {
  const errors: StepErrors = {};
  if (draft.company.displayName.trim().length < 2) errors.displayName = 'Enter the company name.';
  if (slugEditable) {
    const slug = slugRule.safeParse(draft.company.slug);
    if (!slug.success) errors.slug = slug.error.issues[0]?.message ?? 'Invalid identifier.';
  }
  return errors;
}

export function checkBranch(draft: Draft): StepErrors {
  const errors: StepErrors = {};
  if (!draft.branch.name.trim()) errors.branchName = 'Enter the branch name.';
  if (!draft.branch.timezoneName) errors.timezoneName = 'Choose a timezone.';
  if (draft.branch.phone.length > 32) errors.branchPhone = 'At most 32 characters.';
  return errors;
}

export function checkBusiness(draft: Draft): StepErrors {
  const errors: StepErrors = {};
  const { business } = draft;
  if (!/^[A-Z]{3}$/.test(business.currencyCode)) errors.currencyCode = 'Choose a currency.';
  if (business.contactEmail.trim() && !email.safeParse(business.contactEmail).success) {
    errors.contactEmail = 'Enter a valid email address.';
  }
  if (business.setHours) {
    for (const row of business.hours) {
      if (!row.open) continue;
      if (!hhmm.test(row.opensAt) || !hhmm.test(row.closesAt)) {
        errors[`hours-${row.dayOfWeek}`] = 'Use HH:MM for both times.';
      } else if (row.opensAt === row.closesAt) {
        errors[`hours-${row.dayOfWeek}`] = 'Opening and closing time cannot be the same.';
      }
    }
  }
  return errors;
}

export function checkServices(rows: ServiceRow[], currencyCode: string): StepErrors {
  const errors: StepErrors = {};
  const names = new Set<string>();
  const { minorUnit } = currencyFormat(currencyCode);

  for (const row of rows) {
    const name = row.name.trim();
    if (!name) errors[`service-${row.key}-name`] = 'Enter a name.';
    else if (names.has(name.toLowerCase())) errors[`service-${row.key}-name`] = 'Already listed.';
    names.add(name.toLowerCase());

    const duration = Number(row.durationMin);
    if (!Number.isInteger(duration) || duration < 5 || duration > 1440) {
      errors[`service-${row.key}-duration`] = '5 to 1440 minutes.';
    }

    const minor = decimalToMinorString(row.price.trim(), minorUnit);
    if (!row.price.trim() || minor === null || minor.startsWith('-')) {
      errors[`service-${row.key}-price`] =
        minorUnit === 0 ? 'A whole amount, e.g. 5000.' : 'An amount, e.g. 35000 or 35000.50.';
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Payloads. Empty optional fields are omitted, never sent as "".
// ---------------------------------------------------------------------------

const optional = (value: string) => (value.trim() ? value.trim() : undefined);

function hoursPayload(draft: Draft): OnboardingHoursDay[] | undefined {
  if (!draft.business.setHours) return undefined;
  return draft.business.hours.map((row) =>
    row.open
      ? { dayOfWeek: row.dayOfWeek, isClosed: false, opensAt: row.opensAt, closesAt: row.closesAt }
      : { dayOfWeek: row.dayOfWeek, isClosed: true },
  );
}

function branchAndBusiness(draft: Draft) {
  return {
    branch: {
      name: draft.branch.name.trim(),
      timezoneName: draft.branch.timezoneName,
      phone: optional(draft.branch.phone),
      addressLine1: optional(draft.branch.addressLine1),
      addressLine2: optional(draft.branch.addressLine2),
      city: optional(draft.branch.city),
    },
    business: {
      currencyCode: draft.business.currencyCode,
      contactEmail: optional(draft.business.contactEmail),
      contactPhone: optional(draft.business.contactPhone),
      registrationNumber: optional(draft.business.registrationNumber),
      taxNumber: optional(draft.business.taxNumber),
      businessHours: hoursPayload(draft),
    },
  };
}

export function createPayload(draft: Draft): CreateOnboardingCompanyInput {
  return {
    company: {
      displayName: draft.company.displayName.trim(),
      legalName: optional(draft.company.legalName),
      slug: draft.company.slug,
    },
    ...branchAndBusiness(draft),
  };
}

export function setupPayload(draft: Draft): OnboardingSetupInput {
  return {
    company: {
      displayName: draft.company.displayName.trim(),
      legalName: optional(draft.company.legalName),
    },
    ...branchAndBusiness(draft),
  };
}

export function servicesPayload(rows: ServiceRow[], currencyCode: string): InitialServiceInput[] {
  const { minorUnit } = currencyFormat(currencyCode);
  return rows.map((row) => ({
    name: row.name.trim(),
    category: optional(row.category),
    durationMin: Number(row.durationMin),
    priceMinor: decimalToMinorString(row.price.trim(), minorUnit) ?? '0',
    isActive: row.isActive,
  }));
}
