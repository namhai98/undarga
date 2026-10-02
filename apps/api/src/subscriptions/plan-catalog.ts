import type { PrismaClient } from '@prisma/client';

/**
 * ===========================================================================
 * THE PLAN CATALOG — SEED DATA, NOT RUNTIME CONFIGURATION
 * ===========================================================================
 *
 * This file is what `pnpm db:seed` writes into `plan`, `feature` and
 * `plan_entitlement`. Nothing in the application reads these constants to make
 * a decision: every limit and feature check reads the DATABASE, so an operator
 * can change a plan (or grant one company an override in
 * `subscription_entitlement_override`) without a deploy. The keys below are the
 * only thing code refers to.
 */

/** On/off features. Checked with `@RequireFeature` or `EntitlementsService.canUse`. */
export const FEATURES = {
  GIFT_CARDS: 'GIFT_CARDS',
  PROMOTIONS: 'PROMOTIONS',
  ONLINE_BOOKING: 'ONLINE_BOOKING',
  MULTI_BRANCH: 'MULTI_BRANCH',
} as const;
export type FeatureKey = (typeof FEATURES)[keyof typeof FEATURES];

/** Countable limits. NULL in the database means unlimited. */
export const LIMITS = {
  MAX_BRANCHES: 'MAX_BRANCHES',
  MAX_EMPLOYEES: 'MAX_EMPLOYEES',
  MAX_SERVICES: 'MAX_SERVICES',
  MAX_RESOURCES: 'MAX_RESOURCES',
  MAX_CUSTOMERS: 'MAX_CUSTOMERS',
  MAX_APPOINTMENTS_PER_MONTH: 'MAX_APPOINTMENTS_PER_MONTH',
} as const;
export type LimitKey = (typeof LIMITS)[keyof typeof LIMITS];

export const FEATURE_KEYS = Object.values(FEATURES);
export const LIMIT_KEYS = Object.values(LIMITS);

export const FEATURE_DEFINITIONS: Array<{
  key: FeatureKey | LimitKey;
  name: string;
  valueType: 'BOOLEAN' | 'LIMIT' | 'METERED';
  unit?: string;
}> = [
  { key: 'GIFT_CARDS', name: 'Gift cards', valueType: 'BOOLEAN' },
  { key: 'PROMOTIONS', name: 'Promotions and discount codes', valueType: 'BOOLEAN' },
  { key: 'ONLINE_BOOKING', name: 'Online booking page', valueType: 'BOOLEAN' },
  { key: 'MULTI_BRANCH', name: 'More than one branch', valueType: 'BOOLEAN' },
  { key: 'MAX_BRANCHES', name: 'Branches', valueType: 'LIMIT', unit: 'branches' },
  { key: 'MAX_EMPLOYEES', name: 'Employees', valueType: 'LIMIT', unit: 'employees' },
  { key: 'MAX_SERVICES', name: 'Services', valueType: 'LIMIT', unit: 'services' },
  { key: 'MAX_RESOURCES', name: 'Rooms and equipment', valueType: 'LIMIT', unit: 'resources' },
  { key: 'MAX_CUSTOMERS', name: 'Customers', valueType: 'LIMIT', unit: 'customers' },
  {
    key: 'MAX_APPOINTMENTS_PER_MONTH',
    name: 'Appointments per month',
    valueType: 'METERED',
    unit: 'appointments',
  },
];

type Entitlements = Record<FeatureKey, boolean> & Record<LimitKey, number | null>;

/** The plan a newly provisioned company trials. */
export const DEFAULT_TRIAL_PLAN = 'PRO';

export const PLAN_DEFINITIONS: Array<{
  key: string;
  name: string;
  description: string;
  /** Minor units of `currencyCode`, per `interval`. */
  priceMinor: bigint;
  currencyCode: string;
  interval: 'MONTH' | 'YEAR';
  trialDays: number;
  sortOrder: number;
  entitlements: Entitlements;
}> = [
  {
    key: 'FREE',
    name: 'Free',
    description: 'One location, a small team, the essentials.',
    priceMinor: 0n,
    currencyCode: 'MNT',
    interval: 'MONTH',
    trialDays: 0,
    sortOrder: 0,
    entitlements: {
      GIFT_CARDS: false,
      PROMOTIONS: false,
      ONLINE_BOOKING: true,
      MULTI_BRANCH: false,
      MAX_BRANCHES: 1,
      MAX_EMPLOYEES: 2,
      MAX_SERVICES: 10,
      MAX_RESOURCES: 2,
      MAX_CUSTOMERS: 100,
      MAX_APPOINTMENTS_PER_MONTH: 100,
    },
  },
  {
    key: 'STARTER',
    name: 'Starter',
    description: 'A growing single-location business.',
    priceMinor: 4_900_000n,
    currencyCode: 'MNT',
    interval: 'MONTH',
    trialDays: 14,
    sortOrder: 1,
    entitlements: {
      GIFT_CARDS: false,
      PROMOTIONS: true,
      ONLINE_BOOKING: true,
      MULTI_BRANCH: false,
      MAX_BRANCHES: 1,
      MAX_EMPLOYEES: 5,
      MAX_SERVICES: 30,
      MAX_RESOURCES: 5,
      MAX_CUSTOMERS: 1000,
      MAX_APPOINTMENTS_PER_MONTH: 500,
    },
  },
  {
    key: 'PRO',
    name: 'Pro',
    description: 'Several locations, gift cards and promotions.',
    priceMinor: 9_900_000n,
    currencyCode: 'MNT',
    interval: 'MONTH',
    trialDays: 14,
    sortOrder: 2,
    entitlements: {
      GIFT_CARDS: true,
      PROMOTIONS: true,
      ONLINE_BOOKING: true,
      MULTI_BRANCH: true,
      MAX_BRANCHES: 3,
      MAX_EMPLOYEES: 15,
      MAX_SERVICES: 100,
      MAX_RESOURCES: 20,
      MAX_CUSTOMERS: 5000,
      MAX_APPOINTMENTS_PER_MONTH: 2000,
    },
  },
  {
    key: 'BUSINESS',
    name: 'Business',
    description: 'No limits, for chains.',
    priceMinor: 19_900_000n,
    currencyCode: 'MNT',
    interval: 'MONTH',
    trialDays: 14,
    sortOrder: 3,
    entitlements: {
      GIFT_CARDS: true,
      PROMOTIONS: true,
      ONLINE_BOOKING: true,
      MULTI_BRANCH: true,
      MAX_BRANCHES: null,
      MAX_EMPLOYEES: null,
      MAX_SERVICES: null,
      MAX_RESOURCES: null,
      MAX_CUSTOMERS: null,
      MAX_APPOINTMENTS_PER_MONTH: null,
    },
  },
];

/**
 * Write the catalog. Idempotent: plans are upserted by key and their
 * entitlements replaced, so re-running after editing this file updates them.
 * Runs on an owner/platform connection (plan tables are read-only to tenants).
 */
export async function syncPlanCatalog(prisma: PrismaClient): Promise<void> {
  for (const feature of FEATURE_DEFINITIONS) {
    await prisma.feature.upsert({
      where: { key: feature.key },
      create: {
        key: feature.key,
        name: feature.name,
        valueType: feature.valueType,
        unit: feature.unit ?? null,
      },
      update: { name: feature.name, valueType: feature.valueType, unit: feature.unit ?? null },
    });
  }

  for (const plan of PLAN_DEFINITIONS) {
    const row = await prisma.plan.upsert({
      where: { key: plan.key },
      create: {
        key: plan.key,
        name: plan.name,
        description: plan.description,
        priceMinor: plan.priceMinor,
        currencyCode: plan.currencyCode,
        interval: plan.interval,
        trialDays: plan.trialDays,
        sortOrder: plan.sortOrder,
        isPublic: true,
      },
      update: {
        name: plan.name,
        description: plan.description,
        priceMinor: plan.priceMinor,
        currencyCode: plan.currencyCode,
        interval: plan.interval,
        trialDays: plan.trialDays,
        sortOrder: plan.sortOrder,
      },
    });

    await prisma.planEntitlement.deleteMany({ where: { planId: row.id } });
    await prisma.planEntitlement.createMany({
      data: Object.entries(plan.entitlements).map(([featureKey, value]) => ({
        planId: row.id,
        featureKey,
        limitBool: typeof value === 'boolean' ? value : null,
        limitInt: typeof value === 'number' ? value : null,
      })),
    });
  }
}
