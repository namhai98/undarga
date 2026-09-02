#!/usr/bin/env node
/**
 * Applies prisma/sql/001_hardening.sql — everything Prisma cannot express.
 *
 * Run AFTER `prisma migrate deploy`. Idempotent enough to re-run in
 * development, but it is not a migration framework: it sends the file as one
 * simple-protocol query so DO $$ ... $$ blocks and multi-statement DDL work.
 *
 * Also sets development passwords on the two application roles, which the SQL
 * deliberately creates without any — a role with a password baked into a
 * committed file is a credential in git.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const SQL_FILE = path.join(__dirname, '..', 'prisma', 'sql', '001_hardening.sql');

async function main() {
  const url =
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DIRECT_DATABASE_URL ||
    process.env.DATABASE_URL;

  if (!url) {
    console.error(
      'No database URL. Set MIGRATION_DATABASE_URL to the schema owner connection.\n' +
        'It must be the OWNER, not app_tenant: this script creates roles and policies.',
    );
    process.exit(1);
  }

  const sql = fs.readFileSync(SQL_FILE, 'utf8');
  const client = new Client({ connectionString: url });

  await client.connect();

  try {
    console.log(`Applying ${path.relative(process.cwd(), SQL_FILE)} ...`);
    await client.query(sql);

    // Passwords come from the environment so nothing sensitive lives in the
    // SQL file. In production these roles are provisioned by infrastructure and
    // this block is a no-op.
    const tenantPassword = process.env.APP_TENANT_PASSWORD || 'app_tenant_dev';
    const platformPassword = process.env.APP_PLATFORM_PASSWORD || 'app_platform_dev';

    if (process.env.NODE_ENV === 'production' && !process.env.APP_TENANT_PASSWORD) {
      console.error('Refusing to set a default role password in production.');
      process.exit(1);
    }

    await client.query(`ALTER ROLE app_tenant   WITH PASSWORD '${escape(tenantPassword)}'`);
    await client.query(`ALTER ROLE app_platform WITH PASSWORD '${escape(platformPassword)}'`);

    const { rows } = await client.query('SELECT count(*)::int AS count FROM tables_missing_rls');
    if (rows[0].count > 0) {
      const missing = await client.query(
        'SELECT table_name FROM tables_missing_rls ORDER BY table_name',
      );
      console.error(
        `\n${rows[0].count} company-owned table(s) still have no row-level security policy:`,
      );
      missing.rows.forEach((r) => console.error(`  - ${r.table_name}`));
      console.error(
        '\nAdd them to the tenant_tables array in 001_hardening.sql section 8a.\n' +
          'A company-owned table without a policy is a cross-tenant leak waiting to be found.',
      );
      process.exit(1);
    }

    console.log('Hardening applied. Every company-owned table has an RLS policy.');
  } finally {
    await client.end();
  }
}

/** Roles cannot be parameterised in ALTER ROLE; escape the literal instead. */
function escape(value) {
  if (!/^[\w!@#$%^&*()\-+=.]{8,128}$/.test(value)) {
    throw new Error('Role password contains characters that are not safe to inline.');
  }
  return value.replace(/'/g, "''");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
