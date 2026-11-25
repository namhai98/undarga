#!/usr/bin/env node
/**
 * Proves that 001_hardening.sql actually took effect on a database.
 *
 * Read-only. Run after `prisma migrate deploy` + `apply-hardening.js`; CI runs
 * it against an empty database so a deploy that skipped the hardening step —
 * or a migration that quietly dropped one of its objects — fails the build
 * instead of shipping without its guarantees. Checks:
 *
 *   1. The two exclusion constraints that make double booking impossible
 *      exist, are EXCLUDE constraints and are validated.
 *   2. Every table with a `company_id` column has row-level security enabled
 *      AND forced, and at least one policy. (Independent of the
 *      `tables_missing_rls` view the hardening script uses, so the two cross-check.)
 *   3. The platform-only tables refuse tenant connections.
 *   4. The tenant role cannot bypass RLS; neither application role is a superuser.
 *
 * Exits 1 listing every failure; prints a one-line summary on success.
 */
const { Client } = require('pg');

const EXCLUSION_CONSTRAINTS = [
  ['appointment_item', 'appointment_item_employee_no_overlap'],
  ['appointment_resource', 'appointment_resource_no_overlap'],
];

const PLATFORM_ONLY_TABLES = [
  'platform_user',
  'platform_session',
  'user_session',
  'user_token',
  'payment_webhook_event',
];

const APP_ROLES = ['app_tenant', 'app_platform'];

async function main() {
  const url =
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DIRECT_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!url) {
    console.error('No database URL. Set MIGRATION_DATABASE_URL.');
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  const failures = [];

  try {
    // 1. Exclusion constraints.
    for (const [table, name] of EXCLUSION_CONSTRAINTS) {
      const { rows } = await client.query(
        `SELECT c.contype, c.convalidated
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public' AND t.relname = $1 AND c.conname = $2`,
        [table, name],
      );
      if (rows.length === 0) failures.push(`missing exclusion constraint ${table}.${name}`);
      else if (rows[0].contype !== 'x')
        failures.push(`${table}.${name} is not an EXCLUDE constraint`);
      else if (!rows[0].convalidated) failures.push(`${table}.${name} is not validated`);
    }

    // 2. Row-level security on every company-owned table.
    const tenant = await client.query(
      `SELECT t.relname AS table_name,
              t.relrowsecurity AS enabled,
              t.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = t.oid) AS policies
         FROM pg_class t
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relkind IN ('r', 'p')
          AND NOT t.relispartition
          AND EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = t.oid AND a.attname = 'company_id'
                         AND NOT a.attisdropped)
        ORDER BY t.relname`,
    );
    if (tenant.rows.length === 0) failures.push('no table with a company_id column found');
    for (const r of tenant.rows) {
      if (!r.enabled) failures.push(`${r.table_name}: row-level security not enabled`);
      if (!r.forced) failures.push(`${r.table_name}: row-level security not forced`);
      if (r.policies === 0) failures.push(`${r.table_name}: no row-level security policy`);
    }

    // 3. Platform-only tables: RLS forced, and no policy lets a tenant in.
    for (const table of PLATFORM_ONLY_TABLES) {
      const { rows } = await client.query(
        `SELECT t.relforcerowsecurity AS forced,
                bool_and(pg_get_expr(p.polqual, p.polrelid) = 'false') AS deny_only,
                count(p.oid)::int AS policies
           FROM pg_class t
           JOIN pg_namespace n ON n.oid = t.relnamespace
           LEFT JOIN pg_policy p ON p.polrelid = t.oid
          WHERE n.nspname = 'public' AND t.relname = $1
          GROUP BY t.relforcerowsecurity`,
        [table],
      );
      if (rows.length === 0) failures.push(`missing platform table ${table}`);
      else if (!rows[0].forced || rows[0].policies === 0 || !rows[0].deny_only) {
        failures.push(`${table}: not closed to tenant connections`);
      }
    }

    // 4. The tenant role is bound by RLS. app_platform is BYPASSRLS by design
    //    (platform module, webhooks, worker claims) but must not be a superuser.
    const roles = await client.query(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1)`,
      [APP_ROLES],
    );
    for (const role of APP_ROLES) {
      const r = roles.rows.find((x) => x.rolname === role);
      if (!r) failures.push(`missing role ${role}`);
      else if (r.rolsuper) failures.push(`role ${role} is a superuser`);
      else if (role === 'app_tenant' && r.rolbypassrls) {
        failures.push('role app_tenant can bypass row-level security');
      }
    }

    if (failures.length > 0) {
      console.error(`Hardening verification FAILED (${failures.length}):`);
      failures.forEach((f) => console.error(`  - ${f}`));
      process.exit(1);
    }
    console.log(
      `Hardening verified: ${EXCLUSION_CONSTRAINTS.length} exclusion constraints, ` +
        `RLS forced with policies on ${tenant.rows.length} company-owned tables, ` +
        `${PLATFORM_ONLY_TABLES.length} platform tables closed, app_tenant bound by RLS.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
