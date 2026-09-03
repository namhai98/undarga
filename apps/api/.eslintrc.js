/**
 * Lint rules that exist for tenant safety, not style.
 *
 * The Prisma extension in src/database/tenant-prisma.service.ts rejects
 * unscoped queries at runtime, but it cannot see raw SQL and it cannot stop
 * someone injecting the BYPASSRLS client. These rules close both gaps at
 * review time, where the fix is cheap.
 */
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { project: 'tsconfig.json', sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: { node: true, jest: true },
  ignorePatterns: ['.eslintrc.js', 'dist', 'node_modules', 'jest*.config.js'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    // A leading underscore marks a parameter that exists for its TYPE or its
    // POSITION rather than its value — required by an interface, or by a mock
    // whose call signature the test asserts on.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',

    // --- tenant-safety rules -------------------------------------------------
    'no-restricted-syntax': [
      'error',
      {
        // Raw SQL bypasses the unscoped-query assertion in the Prisma
        // extension. RLS still applies, but the developer loses the loud
        // failure, so raw access is confined to the allowlisted files below.
        selector:
          "MemberExpression[property.name=/^\\$(queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)$/]",
        message:
          'Raw SQL bypasses the unscoped-query guard. Use a TenantScopedRepository, or add this file to the allowlist in .eslintrc.js after review.',
      },
      {
        // The BYPASSRLS client must never be reachable from feature code.
        selector: "Identifier[name='PlatformPrismaService']",
        message:
          'PlatformPrismaService bypasses row-level security. It is reachable only from src/database, src/tenancy/directory, src/platform and src/jobs — see the allowlist in .eslintrc.js.',
      },
    ],
  },
  overrides: [
    {
      // Files permitted to use raw SQL and/or the BYPASSRLS client. Every entry
      // here is a deliberate, reviewed exception. Adding one is a security
      // decision, not a convenience.
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
        // Writes platform-level rows (company_id NULL), which RLS hides from
        // the tenant connection, and takes an advisory lock for the hash chain.
        'src/audit/audit.service.ts',
        // Claims pending work across tenants, then re-enters each one.
        'src/jobs/**/*.ts',
        'prisma/**/*.ts',
        'scripts/**/*.ts',
        'test/**/*.ts',
      ],
      rules: { 'no-restricted-syntax': 'off' },
    },
  ],
};
