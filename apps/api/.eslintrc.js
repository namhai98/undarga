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
        'src/database/**/*.ts',
        'src/tenancy/directory/**/*.ts',
        'src/platform/**/*.ts',
        'src/audit/audit.repository.ts',
        'src/jobs/**/*.ts',
        'prisma/**/*.ts',
        'test/**/*.ts',
      ],
      rules: { 'no-restricted-syntax': 'off' },
    },
  ],
};
