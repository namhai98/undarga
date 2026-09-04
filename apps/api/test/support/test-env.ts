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
