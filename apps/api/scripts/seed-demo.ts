/**
 * Provision two demo companies in the development database.
 *
 * DEVELOPMENT ONLY. Truncates every table first, so never point it at anything
 * you care about — it refuses to run when NODE_ENV=production.
 *
 * Reuses the isolation suite's fixture rather than duplicating 200 lines of
 * setup: the two adjacent companies it builds are exactly what you want to
 * click around in, and keeping one definition means the thing you demo is the
 * thing the tests cover.
 *
 *   pnpm --filter @undarga/api exec ts-node scripts/seed-demo.ts
 */
import { PrismaClient } from '@prisma/client';
import { seedWorld, TEST_PASSWORD } from '../test/support/seed';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-demo truncates every table. Refusing to run in production.');
  }

  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL to the schema owner connection.');

  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    const world = await seedWorld(prisma);

    console.log('\nDemo tenants provisioned.\n');
    console.log(`  Company A  ${world.companyA.slug}  ${world.companyA.id}`);
    console.log(`  Company B  ${world.companyB.slug}  ${world.companyB.id}`);
    console.log('\nSign in with any of these (password below):\n');
    console.log(`  ${world.userA.email.padEnd(26)} member of Company A only`);
    console.log(`  ${world.userB.email.padEnd(26)} member of Company B only`);
    console.log(`  ${world.userAB.email.padEnd(26)} member of BOTH — use this to test switching`);
    console.log(`  ${world.operator.email.padEnd(26)} platform operator (cross-company)`);
    console.log(`\n  password: ${TEST_PASSWORD}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
