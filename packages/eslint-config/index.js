/**
 * Entry point. Consumers pick the config that matches their runtime:
 *
 *   eslint.config.js  (NestJS)  -> require('@undarga/eslint-config').nest({...})
 *   eslint.config.mjs (Next.js) -> import c from '@undarga/eslint-config'
 *                                  c.correctnessRules / c.testRules
 *
 * The web app composes the RULES rather than the full config, because
 * eslint-config-next already registers the @typescript-eslint plugin and
 * ESLint 9 forbids registering it twice. See rules.js.
 */
const { correctnessRules, testRules, TEST_FILES, SCRIPT_FILES, IGNORES } = require('./rules');

module.exports = {
  base: require('./base'),
  nest: require('./nest'),
  correctnessRules,
  testRules,
  TEST_FILES,
  SCRIPT_FILES,
  IGNORES,
};
