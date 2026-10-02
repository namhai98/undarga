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
        // Same shape as the job runner: the outbox and the notification queue
        // are cross-tenant by nature — a dispatcher that had to be told which
        // company to look at could not find work on its own. Both re-enter each
        // row's company through runInCompany() before writing anything.
        'src/notifications/notification-dispatcher.service.ts',
        'src/notifications/notification-worker.service.ts',
        // The reminder sweep: one cross-tenant query (unnest of each company's
        // offsets against its live appointments) that Prisma cannot express;
        // every write then re-enters the row's company via runInCompany().
        'src/notifications/notification-reminder.service.ts',
        // Subscriptions: a per-(company, limit) advisory lock so concurrent
        // creates cannot overshoot a plan limit; a FOR UPDATE on the
        // subscription row for plan changes; and the lifecycle sweep, which
        // reads across tenants and re-enters each company to write.
        'src/subscriptions/entitlements.service.ts',
        'src/subscriptions/subscriptions.service.ts',
        'src/subscriptions/subscription-lifecycle.service.ts',
        // `SELECT … FOR UPDATE` on one gift card. Prisma has no row-lock API,
        // and without the lock two tills redeeming the same card both see the
        // old balance. The company_id predicate is still in the WHERE and RLS
        // is still active: the lock narrows concurrency, not visibility.
        'src/giftcards/giftcards.service.ts',
        // Same, on a payment row before a refund, plus the ledger posting.
        'src/payments/payments.service.ts',
        // `SELECT … FOR UPDATE` on one appointment before a status change, and
        // `pg_advisory_xact_lock` per employee/resource before a booking write,
        // so concurrent requests for one slot serialise. Both carry company_id
        // (in the WHERE, and in the lock key); RLS stays active. The exclusion
        // constraint remains the guarantee — the locks make it fail politely.
        'src/appointments/appointments.service.ts',
        // Consumes a promotion's redemption counter with a conditional UPDATE:
        //   SET redeemed_count = redeemed_count + 1 WHERE redeemed_count < max
        // Read-then-write would let a promotion capped at 100 be redeemed 103
        // times under load, and that cap is a promise with legal weight.
        'src/promotions/promotions.service.ts',
        // Date-truncated GROUP BY, which Prisma cannot express. The alternative
        // is pulling every payment into memory to bucket it, which is the one
        // thing a reporting layer must not do. Every value is parameterised.
        'src/analytics/**/*.ts',
        'prisma/**/*.ts',
        'scripts/**/*.ts',
        'test/**/*.ts',
      ],
      rules: { 'no-restricted-syntax': 'off' },
    },
  ];
};
