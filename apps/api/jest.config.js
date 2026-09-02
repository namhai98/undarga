/**
 * Unit tests. No database, no network. Everything here must run with
 * `pnpm test` on a clean checkout after `pnpm install`.
 */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '\.spec\.ts$',
  // The isolation suite ends in .e2e-spec.ts and needs a live database; it has
  // its own config. Excluded explicitly so a stray match can never drag it in.
  testPathIgnorePatterns: ['/node_modules/', '\.e2e-spec\.ts$'],
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@test/(.*)$': '<rootDir>/test/$1',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/main.ts'],
  coverageDirectory: 'coverage',
  clearMocks: true,
};
