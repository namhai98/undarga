/**
 * Integration / isolation tests. REQUIRES a live PostgreSQL with the schema
 * migrated AND 001_hardening.sql applied — the isolation suite asserts on RLS
 * behaviour, so a database without the hardening SQL will produce false passes.
 *
 *   docker compose up -d postgres-test
 *   pnpm db:deploy          # migrate + harden
 *   pnpm test:e2e
 *
 * Runs serially (--runInBand): the suite truncates tables between cases.
 */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '\.e2e-spec\.ts$',
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@test/(.*)$': '<rootDir>/test/$1',
  },
  globalSetup: '<rootDir>/test/support/global-setup.ts',
  setupFilesAfterEnv: ['<rootDir>/test/support/setup-after-env.ts'],
  testTimeout: 30000,
  maxWorkers: 1,
  clearMocks: true,
};
