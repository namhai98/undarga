const base = require('./base');

/**
 * Backend config: the shared correctness rules plus the tenant-safety rules.
 *
 * ---------------------------------------------------------------------------
 * WHY LINT RULES ARE PART OF THE SECURITY MODEL
 * ---------------------------------------------------------------------------
 *
 * The Prisma extension in `src/database/tenant-scope.guard-extension.ts`
 * refuses unscoped queries at runtime, and row-level security refuses them at
 * the database. Neither can see two things:
 *
 *   1. Raw SQL. `$queryRaw` bypasses the extension entirely. RLS still applies,
 *      but the developer loses the loud failure that makes the mistake obvious.
 *   2. The BYPASSRLS client. `PlatformPrismaService` is a master key; nothing
 *      stops feature code injecting it except review.
 *
 * These rules close both gaps at review time, where the fix costs a minute.
 * The allowlist below is the complete set of places either is permitted, and
 * every entry has a reason. Adding one is a security decision.
 */
module.exports = function nest({ tsconfigRootDir, project = true } = {}) {
  return [
    ...base({ tsconfigRootDir, project }),

    {
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "MemberExpression[property.name=/^\\$(queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)$/]",
            message:
              'Raw SQL bypasses the unscoped-query guard. Use a TenantScopedRepository, or add this file to the allowlist in packages/eslint-config/nest.js after review.',
          },
          {
            selector: "Identifier[name='PlatformPrismaService']",
            message:
              'PlatformPrismaService bypasses row-level security. See the allowlist in packages/eslint-config/nest.js.',
          },
        ],
      },
    },

    {
      files: [
        // Owns both connections.
        'src/database/**/*.ts',
        // Resolves host/slug -> company. Cannot be tenant-scoped: it is the
        // query that determines the scope.
        'src/tenancy/directory/**/*.ts',
        // Cross-company by definition, permission-gated and audited.
        'src/platform/**/*.ts',
        // Authentication runs before a company is known, and RLS denies the
        // tenant connection any access to credential tables.
        'src/auth/identity.repository.ts',
        // One-time email-verification and password-reset tokens. Same reason:
        // both flows run before a company is known, and `user_token` is closed
        // to tenant connections outright.
        'src/auth/user-token.repository.ts',
        // Looks an invitation up by token hash — a lookup that by definition
        // precedes knowing the company, since the invitation is what names it.
        // One method, filtered on a 256-bit HMAC the caller had to present, and
        // the company it yields is then entered through runInCompany().
        'src/members/invitation-token.repository.ts',
        // Writes platform-level rows (company_id NULL), which RLS hides from
        // the tenant connection, and takes an advisory lock for the hash chain.
        'src/audit/audit.service.ts',
        // `SELECT 1` needs no tenant; the tenant pool would demand one.
        'src/health/health.service.ts',
        // Claims pending work across tenants, then re-enters each one.
        'src/jobs/**/*.ts',
        'prisma/**/*.ts',
        'scripts/**/*.ts',
        'test/**/*.ts',
      ],
      rules: { 'no-restricted-syntax': 'off' },
    },
  ];
};
