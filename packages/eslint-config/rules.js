/**
 * Rule choices, separated from plugin registration.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS SEPARATE FROM base.js
 * ---------------------------------------------------------------------------
 *
 * ESLint 9 refuses to let two configs register the same plugin
 * ("Cannot redefine plugin @typescript-eslint"). `eslint-config-next` registers
 * `@typescript-eslint` itself, so the web app cannot also spread a config that
 * registers it — which is what `typescript-eslint`'s presets do.
 *
 * Splitting the *rules* out means both apps agree on the same standards while
 * each lets whoever got there first own the plugin instance:
 *
 *   apps/api  -> base.js registers the plugin, then applies these rules.
 *   apps/web  -> eslint-config-next registers it, then these rules apply on top.
 *
 * Without this split the two apps would drift apart on rule choices, which is
 * exactly what a shared config package exists to prevent.
 */

/** Correctness rules applied to every TypeScript file in the workspace. */
const correctnessRules = {
  '@typescript-eslint/explicit-function-return-type': 'off',
  '@typescript-eslint/explicit-module-boundary-types': 'off',
  '@typescript-eslint/no-explicit-any': 'warn',

  // A leading underscore marks a parameter that exists for its TYPE or
  // POSITION rather than its value — required by an interface, or by a mock
  // whose call signature a test asserts on.
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
  ],

  // The two rules that justify type-aware linting on their own. A forgotten
  // `await` on a database write is silent data loss that no test reliably
  // catches.
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',

  // A function returning a Promise to satisfy an interface is correct with no
  // internal await — every repository adapter, React Server Component and test
  // stub here is one.
  '@typescript-eslint/require-await': 'off',

  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-console': ['warn', { allow: ['warn', 'error'] }],
};

/**
 * Relaxations for test files.
 *
 * Assertions against loosely-typed response bodies are normal in tests;
 * forcing `any` out of them adds noise without adding safety.
 */
const testRules = {
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-unsafe-assignment': 'off',
  '@typescript-eslint/no-unsafe-member-access': 'off',
  '@typescript-eslint/no-unsafe-argument': 'off',
  '@typescript-eslint/no-unsafe-call': 'off',
  '@typescript-eslint/no-unsafe-return': 'off',
  'no-console': 'off',
};

const TEST_FILES = [
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.e2e-spec.ts',
  '**/test/**/*.ts',
  '**/test/**/*.tsx',
];

/** Seeds, migrations and CLI tooling exist to print to the console. */
const SCRIPT_FILES = ['**/scripts/**/*.ts', '**/prisma/**/*.ts'];

const IGNORES = [
  'dist/**',
  'build/**',
  '.next/**',
  'coverage/**',
  'node_modules/**',
  // Plain JS is outside every tsconfig, so the type-aware parser cannot load
  // it. Ops scripts are reviewed, not linted.
  '**/*.js',
  '**/*.mjs',
  '**/*.cjs',
];

module.exports = { correctnessRules, testRules, TEST_FILES, SCRIPT_FILES, IGNORES };
