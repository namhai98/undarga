import { PrismaClient } from '@prisma/client';
import {
  ALL_COMPANY_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  SYSTEM_ROLES,
} from '../src/authz/permissions';
import { PLAN_DEFINITIONS, syncPlanCatalog } from '../src/subscriptions/plan-catalog';

/**
 * Reference data the application cannot start without.
 *
 * Everything here is a foreign-key target: a company cannot be created before
 * its currency and timezone rows exist, and a role cannot be granted a
 * permission that is not in the catalog. Idempotent, so it is safe to re-run
 * after every migration.
 *
 * Deliberately seeds NO tenant data. Companies are created through
 * provisioning, not through a fixture.
 */
const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

async function seedTimezones(): Promise<number> {
  // Sourced from the server's own tzdata so the table can never contain a zone
  // Postgres does not recognise. A reconciliation job should re-run this after
  // a Postgres image upgrade; see docs/DATABASE.md 15.3.
  const zones = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM pg_timezone_names WHERE name NOT LIKE 'posix/%'
  `;

  await prisma.timezone.createMany({
    data: zones.map((z) => ({ name: z.name })),
    skipDuplicates: true,
  });

  return zones.length;
}

async function seedCurrencies(): Promise<void> {
  // minorUnit is the ISO 4217 exponent and drives all formatting. Nothing in
  // the codebase assumes 100 — see docs/DATABASE.md 16.
  await prisma.currency.createMany({
    data: [
      { code: 'MNT', name: 'Mongolian tugrik', symbol: '₮', minorUnit: 2 },
      { code: 'USD', name: 'United States dollar', symbol: '$', minorUnit: 2 },
      { code: 'EUR', name: 'Euro', symbol: '€', minorUnit: 2 },
      { code: 'GBP', name: 'Pound sterling', symbol: '£', minorUnit: 2 },
      { code: 'JPY', name: 'Japanese yen', symbol: '¥', minorUnit: 0 },
      { code: 'KRW', name: 'South Korean won', symbol: '₩', minorUnit: 0 },
      { code: 'CNY', name: 'Renminbi', symbol: '¥', minorUnit: 2 },
      { code: 'RUB', name: 'Russian rouble', symbol: '₽', minorUnit: 2 },
    ],
    skipDuplicates: true,
  });
}

async function seedPermissions(): Promise<void> {
  await prisma.permission.createMany({
    data: [
      ...ALL_COMPANY_PERMISSIONS.map((key) => ({
        key,
        scope: 'COMPANY' as const,
        category: key.split(':')[0] ?? 'general',
        description: key,
      })),
      ...ALL_PLATFORM_PERMISSIONS.map((key) => ({
        key,
        scope: 'PLATFORM' as const,
        category: 'platform',
        description: key,
      })),
    ],
    skipDuplicates: true,
  });
}

async function seedPlatformRoles(): Promise<void> {
  const roles = [
    { key: 'SUPER_ADMIN', name: 'Super administrator', permissions: ALL_PLATFORM_PERMISSIONS },
    {
      key: 'SUPPORT',
      name: 'Support',
      permissions: ALL_PLATFORM_PERMISSIONS.filter(
        (p) => p.includes(':list') || p.includes(':read') || p === 'platform:impersonate',
      ),
    },
    {
      key: 'BILLING',
      name: 'Billing',
      permissions: ALL_PLATFORM_PERMISSIONS.filter(
        (p) => p.startsWith('platform:billing') || p.startsWith('platform:plan'),
      ),
    },
  ];

  for (const role of roles) {
    const created = await prisma.platformRole.upsert({
      where: { key: role.key },
      update: { name: role.name },
      create: { key: role.key, name: role.name, isSystem: true },
    });

    await prisma.platformRolePermission.createMany({
      data: role.permissions.map((permissionKey) => ({ roleId: created.id, permissionKey })),
      skipDuplicates: true,
    });
  }
}

/**
 * The system role templates, for reference by the provisioning flow.
 *
 * Not written to the database here: `company_role` rows are per company and are
 * created when a company is provisioned. This function only asserts that every
 * permission the templates reference actually exists in the catalog — a typo in
 * SYSTEM_ROLE_PERMISSIONS would otherwise surface as a silently missing grant
 * on the first customer.
 */
function verifySystemRoleTemplates(): void {
  const catalog = new Set<string>(ALL_COMPANY_PERMISSIONS);
  const problems: string[] = [];

  for (const [roleKey, permissions] of Object.entries(SYSTEM_ROLE_PERMISSIONS)) {
    for (const permission of permissions) {
      if (!catalog.has(permission)) {
        problems.push(`${roleKey} references unknown permission "${permission}"`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`System role templates are inconsistent:\n  ${problems.join('\n  ')}`);
  }
}

async function main(): Promise<void> {
  verifySystemRoleTemplates();

  const zoneCount = await seedTimezones();
  await seedCurrencies();
  await seedPermissions();
  await seedPlatformRoles();
  // Plans, features and their entitlements (src/subscriptions/plan-catalog.ts).
  await syncPlanCatalog(prisma);

  console.log(
    `Seeded ${zoneCount} timezones, 8 currencies, ` +
      `${ALL_COMPANY_PERMISSIONS.length + ALL_PLATFORM_PERMISSIONS.length} permissions, ` +
      `3 platform roles, ${PLAN_DEFINITIONS.length} plans.`,
  );
  console.log(`System role templates verified: ${Object.keys(SYSTEM_ROLES).length} roles.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
