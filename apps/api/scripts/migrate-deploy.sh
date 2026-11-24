#!/bin/sh
# Production database update: the ONE command a deployment runs before
# starting the new API version (docs/DEPLOYMENT.md).
#
#   1. prisma migrate deploy   applies pending migrations, in order; never
#                              resets, never generates, never prompts
#   2. apply-hardening.js      roles, grants, row-level security, partial
#                              indexes — idempotent, re-run every deploy
#   3. prisma/seed.ts          reference data only (timezones, currencies,
#                              permissions, plans, platform roles) — idempotent
#
# Never seeds demo data and never resets: there is no flag for either.
# Take a backup before running it when the release notes flag a risky
# migration.
#
# Environment: MIGRATION_DATABASE_URL (schema owner), APP_TENANT_PASSWORD,
# APP_PLATFORM_PASSWORD, NODE_ENV=production.
set -eu

: "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL must point at the schema owner role}"

cd "$(dirname "$0")/.."

echo "==> Applying migrations"
DATABASE_URL="$MIGRATION_DATABASE_URL" npx --no-install prisma migrate deploy

echo "==> Applying hardening (roles, grants, row-level security)"
node scripts/apply-hardening.js

echo "==> Seeding reference data"
npx --no-install ts-node --transpile-only prisma/seed.ts

echo "==> Database is up to date"
