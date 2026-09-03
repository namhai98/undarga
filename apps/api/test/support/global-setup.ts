import { PrismaClient } from '@prisma/client';

/**
 * Refuses to run the isolation suite against a database that cannot prove
 * anything.
 *
 * The suite asserts on row-level security behaviour. Against a database where
 * the migration ran but 001_hardening.sql did not, most of these tests would
 * still PASS — the repository layer alone blocks cross-tenant access — and the
 * green run would be a lie about the property that actually matters.
 *
 * So: verify the hardening is present, and fail loudly with instructions if it
 * is not.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      'No database URL. Isolation tests need a real PostgreSQL:\n' +
        '  docker compose up -d postgres-test\n' +
        '  pnpm db:deploy\n' +
        '  pnpm test:e2e',
    );
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    await prisma.$connect();
  } catch (error) {
    throw new Error(
      `Cannot reach the test database at ${redact(url)}.\n` +
        'Start it with: docker compose up -d postgres-test\n' +
        `Underlying error: ${(error as Error).message}`,
    );
  }

  const rlsRows = await prisma.$queryRaw<
    Array<{ count: bigint }>
  >`SELECT count(*)::bigint AS count FROM tables_missing_rls`.catch(
    () => [{ count: -1n }] as Array<{ count: bigint }>,
  );

  const missingRls = rlsRows[0]?.count ?? -1n;

  if (missingRls === -1n) {
    throw new Error(
      'The view "tables_missing_rls" does not exist, so 001_hardening.sql has not been ' +
        'applied. Without it there is no row-level security and this suite would pass ' +
        'for the wrong reason.\n  Run: pnpm db:deploy',
    );
  }

  if (missingRls > 0n) {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM tables_missing_rls ORDER BY table_name
    `;
    throw new Error(
      `${missingRls} company-owned table(s) have no row-level security policy:\n` +
        rows.map((r) => `  - ${r.table_name}`).join('\n') +
        '\nRun: pnpm db:harden',
    );
  }

  const roles = await prisma.$queryRaw<Array<{ rolname: string; rolbypassrls: boolean }>>`
    SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('app_tenant', 'app_platform')
  `;

  const tenantRole = roles.find((r) => r.rolname === 'app_tenant');
  if (!tenantRole) {
    throw new Error('The app_tenant role does not exist. Run: pnpm db:harden');
  }
  if (tenantRole.rolbypassrls) {
    throw new Error(
      'app_tenant has BYPASSRLS. Every isolation assertion in this suite would pass ' +
        'vacuously. Fix the role before continuing.',
    );
  }

  await prisma.$disconnect();
}

function redact(url: string): string {
  return url.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@');
}
