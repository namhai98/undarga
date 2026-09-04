const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const prettier = require('eslint-config-prettier');
const globals = require('globals');
const {
  correctnessRules,
  testRules,
  TEST_FILES,
  SCRIPT_FILES,
  IGNORES,
} = require('./rules');

/**
 * Full config for a workspace that owns its plugin registration.
 *
 * Registers `@typescript-eslint` via typescript-eslint's presets, then applies
 * the shared rule choices from `rules.js`. Use this where nothing else has
 * already registered the plugin — i.e. the backend. The web app composes
 * `eslint-config-next` with the same rules instead; see `rules.js` for why.
 *
 * Formatting is NOT here. Prettier owns formatting and runs as its own script;
 * `eslint-config-prettier` switches off the rules that would fight it. Running
 * Prettier *through* ESLint works but makes lint several times slower and turns
 * every formatting nit into an "error", which trains people to ignore errors.
 */
module.exports = function base({ tsconfigRootDir, project = true } = {}) {
  return tseslint.config(
    { ignores: IGNORES },

    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,

    {
      languageOptions: {
        parserOptions: { project, tsconfigRootDir },
        globals: { ...globals.node, ...globals.es2022 },
      },
      rules: correctnessRules,
    },

    { files: SCRIPT_FILES, rules: { 'no-console': 'off' } },
    { files: TEST_FILES, rules: testRules },

    prettier,
  );
};
