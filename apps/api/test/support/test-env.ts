import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Point the e2e suite at the TEST database, before anything reads config.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * `seedWorld()` runs `TRUNCATE ... CASCADE` on every table between test cases.
 * The root `.env` points at the development database. Without this mapping,
 * running `pnpm test:e2e` silently destroys whatever you were working on —
 * and it is exactly the command someone runs without thinking twice.
 *
 * So the suite reads `TEST_*` variables and refuses to start if they are
 * missing or if they point at the same database as development. A guard that
 * only works when someone remembered to set it is not a guard.
 *
 * Loaded from `setupFiles` (not `setupFilesAfterEnv`), which runs before the
 * module registry, so `ConfigModule` sees the swapped values at import time.
 */
/**
 * Marks the mapping as done.
 *
 * `globalSetup` runs in the main process and Jest forks workers from it, so by
 * the time `setupFiles` runs in a worker the target variables already hold the
 * test URLs. Without this sentinel the equality check below would read that as
 * "both point at the same database" and refuse to run — the guard tripping over
 * its own success.
 */
const APPLIED = '__UNDARGA_TEST_ENV_APPLIED';

export function applyTestDatabaseEnv(): void {
  if (process.env[APPLIED] === '1') return;

  const mappings: Array<[test: string, target: string]> = [
    ['TEST_DATABASE_URL', 'DATABASE_URL'],
    ['TEST_PLATFORM_DATABASE_URL', 'PLATFORM_DATABASE_URL'],
    ['TEST_MIGRATION_DATABASE_URL', 'MIGRATION_DATABASE_URL'],
  ];

  const missing = mappings.filter(([source]) => !process.env[source]).map(([source]) => source);

  if (missing.length > 0) {
    throw new Error(
      `The e2e suite truncates every table, so it must not run against the development ` +
        `database.\n\nMissing: ${missing.join(', ')}\n\n` +
        `Add them to .env (see .env.example) pointing at a separate database, e.g.\n` +
        `  TEST_DATABASE_URL=postgresql://app_tenant:app_tenant_dev@localhost:5432/undarga_test`,
    );
  }

  for (const [source, target] of mappings) {
    const testUrl = process.env[source]!;
    const devUrl = process.env[target];

    if (devUrl && normalise(devUrl) === normalise(testUrl)) {
      throw new Error(
        `${source} and ${target} point at the same database. The e2e suite would ` +
          `truncate your development data. Use a separate database (conventionally ` +
          `"undarga_test").`,
      );
    }

    process.env[target] = testUrl;
  }

  // The suites deliver to the in-memory mock providers (they assert on what was
  // "sent" and make it fail on demand). Explicit, because the default outside
  // production is the `log` provider. A suite needing a real adapter wires one
  // itself with a mocked fetch.
  process.env.EMAIL_PROVIDER ??= 'mock';
  process.env.SMS_PROVIDER ??= 'mock';
  process.env.PUSH_PROVIDER ??= 'mock';
  // A fixed, obviously-fake 32-byte key so company provider accounts can be
  // saved and read back. Test-only; it protects nothing.
  process.env.SECRETS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
  // Twilio receipts are signed over the full URL, so the suite needs a base.
  process.env.NOTIFICATION_WEBHOOK_BASE_URL ??= 'https://api.undarga.test';
  // Calendar: a fake Google OAuth client (the suite answers Google's URLs with
  // a mocked fetch). Microsoft stays unconfigured, to test exactly that.
  process.env.GOOGLE_CALENDAR_CLIENT_ID ??= 'test-client.apps.googleusercontent.test';
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET ??= 'test-client-secret-not-real';
  process.env.MICROSOFT_CALENDAR_CLIENT_ID = '';
  process.env.MICROSOFT_CALENDAR_CLIENT_SECRET = '';
  process.env.CALENDAR_OAUTH_REDIRECT_URL ??= 'https://app.undarga.test/calendar/callback';
  // Files: local storage in a throwaway directory, and a fixed public origin
  // for the URLs the API hands out (the suite requests their paths).
  process.env.STORAGE_DRIVER ??= 'local';
  process.env.STORAGE_LOCAL_ROOT ??= join(tmpdir(), `undarga-test-storage-${process.pid}`);
  process.env.API_PUBLIC_URL ??= 'https://api.undarga.test';

  // Rate-limit counters and session revocations live in Redis. A prefix per
  // run keeps one run's counters (and the dev server's) out of the next.
  process.env.REDIS_KEY_PREFIX = `undarga-test:${process.pid}-${Date.now()}:`;

  process.env[APPLIED] = '1';
}

/** Compare host + database only; credentials and query params are noise here. */
function normalise(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
