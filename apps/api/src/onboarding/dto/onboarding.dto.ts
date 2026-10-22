import { z } from 'zod';
import {
  branchAddressFields,
  branchCodeSchema,
  businessHoursDaySchema,
} from '../../branches/dto/branch.dto';
import { companySlugSchema } from '../../platform/companies/dto/provision-company.dto';

/**
 * Onboarding validates with the SAME rules as the endpoints it stands in for:
 * the slug rules (reserved names included) come from provisioning, and the
 * branch code, address and opening-hours rules from the branches module. A
 * company created here is one those endpoints could have created.
 *
 * Nothing in any schema below names an owner, a user or a company id. The
 * owner is the caller's verified token; the company is the one being created,
 * or the one the route's `:companyId` resolved to after a membership check.
 */

const currencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'Use an uppercase ISO 4217 code, e.g. MNT.');

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

/** Step 1. The logo is not here: there is no file-upload infrastructure yet. */
const companyStep = z
  .object({
    displayName: z.string().trim().min(2, 'Enter the company name.').max(160),
    /** Defaults to the display name. */
    legalName: z.string().trim().min(2).max(160).optional(),
    slug: companySlugSchema,
  })
  .strict();

/** Step 2. The branch timezone is also the company's default timezone. */
const branchStep = z
  .object({
    name: z.string().trim().min(1, 'Enter the branch name.').max(128),
    /** Defaults to `MAIN`. */
    code: branchCodeSchema.optional(),
    timezoneName: z.string().trim().min(1).max(64),
    phone: branchAddressFields.phone,
    email: branchAddressFields.email,
    addressLine1: branchAddressFields.addressLine1,
    addressLine2: branchAddressFields.addressLine2,
    city: branchAddressFields.city,
    district: branchAddressFields.district,
    postalCode: branchAddressFields.postalCode,
    countryCode: branchAddressFields.countryCode,
  })
  .strict();

/** A week of opening hours, one entry per day at most. */
const businessWeek = z
  .array(businessHoursDaySchema)
  .min(1)
  .max(7)
  .superRefine((days, ctx) => {
    const seen = new Set<number>();
    for (const day of days) {
      if (seen.has(day.dayOfWeek)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Day ${day.dayOfWeek} appears more than once.`,
        });
        return;
      }
      seen.add(day.dayOfWeek);
    }
  });

/** Step 3. */
const businessStep = z
  .object({
    currencyCode,
    locale: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/, 'Use a locale like en-US or mn-MN.')
      .optional(),
    contactEmail: z.string().trim().toLowerCase().email().max(320).optional(),
    contactPhone: optionalText(32),
    registrationNumber: optionalText(64),
    taxNumber: optionalText(64),
    /** Optional. Days left out are closed. */
    businessHours: businessWeek.optional(),
  })
  .strict();

/** `POST /onboarding/company` — steps 1 to 3, created in one transaction. */
export const createOnboardingCompanySchema = z
  .object({ company: companyStep, branch: branchStep, business: businessStep })
  .strict();
export type CreateOnboardingCompanyDto = z.infer<typeof createOnboardingCompanySchema>;

/**
 * `POST /onboarding/companies/:companyId/setup` — steps 2 and 3 for a company
 * that already exists (provisioned by an operator). Its slug is fixed: other
 * systems may already have cached it.
 */
export const onboardingSetupSchema = z
  .object({
    company: companyStep.omit({ slug: true }),
    branch: branchStep,
    business: businessStep,
  })
  .strict();
export type OnboardingSetupDto = z.infer<typeof onboardingSetupSchema>;

/** One initial service (step 4). Price in minor units, as everywhere else. */
const initialService = z
  .object({
    name: z.string().trim().min(1, 'Enter the service name.').max(160),
    /** A category NAME. Reused if the company already has it, else created. */
    category: z.string().trim().min(1).max(128).optional(),
    durationMin: z.number().int().min(5).max(1440),
    priceMinor: z.string().regex(/^\d{1,15}$/, 'Use a whole number of minor units, e.g. "50000".'),
    isActive: z.boolean().default(true),
  })
  .strict();

/**
 * `POST /onboarding/companies/:companyId/complete` — step 4 and the finish.
 * An empty or absent `services` list is the skipped step.
 */
export const completeOnboardingSchema = z
  .object({ services: z.array(initialService).max(20).default([]) })
  .strict()
  .superRefine((value, ctx) => {
    const names = new Set<string>();
    value.services.forEach((service, index) => {
      const key = service.name.toLowerCase();
      if (names.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Two services have the same name.',
          path: ['services', index, 'name'],
        });
      }
      names.add(key);
    });
  });
export type CompleteOnboardingDto = z.infer<typeof completeOnboardingSchema>;

export const onboardingStatusQuerySchema = z
  .object({
    /** Which of the caller's companies to report on. Defaults to the active one. */
    companyId: z.string().uuid().optional(),
  })
  .strict();
export type OnboardingStatusQueryDto = z.infer<typeof onboardingStatusQuerySchema>;

export const slugAvailabilityQuerySchema = z
  .object({ slug: z.string().trim().toLowerCase().min(1).max(64) })
  .strict();
export type SlugAvailabilityQueryDto = z.infer<typeof slugAvailabilityQuerySchema>;
