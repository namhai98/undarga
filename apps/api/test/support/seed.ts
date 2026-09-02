import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import {
  ALL_COMPANY_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  COMPANY_PERMISSIONS,
  PLATFORM_PERMISSIONS,
} from '../../src/authz/permissions';

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export interface SeededCompany {
  id: string;
  slug: string;
  branchId: string;
  customerId: string;
  appointmentId: string;
  paymentId: string;
}

export interface SeededWorld {
  companyA: SeededCompany;
  companyB: SeededCompany;
  /** Belongs to company A only. */
  userA: { id: string; email: string };
  /** Belongs to company B only. */
  userB: { id: string; email: string };
  /** Belongs to BOTH — the multi-membership case. */
  userAB: { id: string; email: string };
  /** Platform operator with cross-company data:read. */
  operator: { id: string; email: string };
  /** Platform operator with NO data permission. */
  weakOperator: { id: string; email: string };
}

/**
 * Builds two complete, adjacent companies.
 *
 * Adjacent matters: every isolation assertion is only meaningful if the row it
 * must not see actually exists. A suite that passes because company B has no
 * appointments proves nothing.
 *
 * Runs on the migration/owner connection, so it can write regardless of RLS.
 */
export async function seedWorld(prisma: PrismaClient): Promise<SeededWorld> {
  await resetDatabase(prisma);

  await prisma.timezone.createMany({
    data: [{ name: 'Asia/Ulaanbaatar' }, { name: 'UTC' }, { name: 'Europe/Berlin' }],
    skipDuplicates: true,
  });

  await prisma.currency.createMany({
    data: [
      { code: 'MNT', name: 'Mongolian tugrik', symbol: '₮', minorUnit: 2 },
      { code: 'USD', name: 'United States dollar', symbol: '$', minorUnit: 2 },
    ],
    skipDuplicates: true,
  });

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

  const passwordHash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id });

  const companyA = await seedCompany(prisma, 'company-a', 'Company A');
  const companyB = await seedCompany(prisma, 'company-b', 'Company B');

  const userA = await seedUser(prisma, 'user-a@example.com', 'User A', passwordHash);
  const userB = await seedUser(prisma, 'user-b@example.com', 'User B', passwordHash);
  const userAB = await seedUser(prisma, 'user-ab@example.com', 'User AB', passwordHash);

  await addMembership(prisma, companyA.id, userA.id);
  await addMembership(prisma, companyB.id, userB.id);
  // The multi-membership case: manager in A, receptionist in B.
  await addMembership(prisma, companyA.id, userAB.id);
  await addMembership(prisma, companyB.id, userAB.id);

  const operator = await seedPlatformUser(
    prisma,
    'ops@platform.test',
    'Operator',
    passwordHash,
    'SUPPORT',
    [
      PLATFORM_PERMISSIONS.COMPANY_LIST,
      PLATFORM_PERMISSIONS.COMPANY_DATA_READ,
      PLATFORM_PERMISSIONS.COMPANY_DATA_WRITE,
    ],
  );

  const weakOperator = await seedPlatformUser(
    prisma,
    'billing@platform.test',
    'Billing Operator',
    passwordHash,
    'BILLING',
    [PLATFORM_PERMISSIONS.BILLING_MANAGE],
  );

  return { companyA, companyB, userA, userB, userAB, operator, weakOperator };
}

async function seedCompany(
  prisma: PrismaClient,
  slug: string,
  name: string,
): Promise<SeededCompany> {
  const company = await prisma.company.create({
    data: {
      slug,
      legalName: `${name} LLC`,
      displayName: name,
      status: 'ACTIVE',
      defaultTimezoneName: 'Asia/Ulaanbaatar',
      currencyCode: 'MNT',
    },
  });

  // One role holding the whole company catalog, so permission checks never mask
  // an isolation failure. Permission granularity is exercised by unit tests.
  const role = await prisma.companyRole.create({
    data: { companyId: company.id, key: 'FULL', name: 'Full access', isSystem: false },
  });

  await prisma.companyRolePermission.createMany({
    data: ALL_COMPANY_PERMISSIONS.map((permissionKey) => ({
      companyId: company.id,
      roleId: role.id,
      permissionKey,
    })),
  });

  const branch = await prisma.branch.create({
    data: {
      companyId: company.id,
      code: 'MAIN',
      name: `${name} main branch`,
      timezoneName: 'Asia/Ulaanbaatar',
    },
  });

  const customer = await prisma.companyCustomer.create({
    data: {
      companyId: company.id,
      firstName: `${name} customer`,
      lastName: 'Test',
      email: `customer@${slug}.test`,
      phone: `+9769900000${slug.endsWith('a') ? '1' : '2'}`,
    },
  });

  const appointment = await prisma.appointment.create({
    data: {
      companyId: company.id,
      branchId: branch.id,
      customerId: customer.id,
      appointmentNumber: `${slug.toUpperCase()}-0001`,
      status: 'CONFIRMED',
      paymentStatus: 'UNPAID',
      source: 'STAFF',
      startsAt: new Date('2026-10-01T02:00:00Z'),
      endsAt: new Date('2026-10-01T03:00:00Z'),
      bookedTimezoneName: 'Asia/Ulaanbaatar',
      currencyCode: 'MNT',
      totalMinor: 5_000_000n,
    },
  });

  const payment = await prisma.payment.create({
    data: {
      companyId: company.id,
      branchId: branch.id,
      appointmentId: appointment.id,
      customerId: customer.id,
      paymentNumber: `${slug.toUpperCase()}-PAY-0001`,
      method: 'CASH',
      purpose: 'BOOKING',
      status: 'SUCCEEDED',
      amountMinor: 5_000_000n,
      currencyCode: 'MNT',
    },
  });

  return {
    id: company.id,
    slug,
    branchId: branch.id,
    customerId: customer.id,
    appointmentId: appointment.id,
    paymentId: payment.id,
  };
}

async function seedUser(
  prisma: PrismaClient,
  email: string,
  fullName: string,
  passwordHash: string,
) {
  const user = await prisma.userAccount.create({
    data: { email, fullName, passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  return { id: user.id, email };
}

async function addMembership(prisma: PrismaClient, companyId: string, userAccountId: string) {
  const membership = await prisma.companyUser.create({
    data: { companyId, userAccountId, status: 'ACTIVE', isOwner: false, joinedAt: new Date() },
  });

  const role = await prisma.companyRole.findFirstOrThrow({ where: { companyId, key: 'FULL' } });

  await prisma.companyUserRole.create({
    data: { companyId, companyUserId: membership.id, roleId: role.id },
  });

  return membership;
}

async function seedPlatformUser(
  prisma: PrismaClient,
  email: string,
  fullName: string,
  passwordHash: string,
  roleKey: string,
  permissions: readonly string[],
) {
  const user = await prisma.platformUser.create({
    data: { email, fullName, passwordHash, status: 'ACTIVE', mfaEnrolledAt: new Date() },
  });

  const role = await prisma.platformRole.upsert({
    where: { key: roleKey },
    update: {},
    create: { key: roleKey, name: roleKey, isSystem: true },
  });

  await prisma.platformRolePermission.createMany({
    data: permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })),
    skipDuplicates: true,
  });

  await prisma.platformUserRole.create({ data: { platformUserId: user.id, roleId: role.id } });

  return { id: user.id, email };
}

/**
 * Truncate everything between suites.
 *
 * `TRUNCATE ... CASCADE` on the owner connection, not `deleteMany` in
 * dependency order: the schema has ~78 tables with composite foreign keys, and
 * a hand-maintained delete order is a list that rots.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT LIKE '_prisma%'
  `;

  if (tables.length === 0) return;

  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
