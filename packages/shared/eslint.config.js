const { base } = require('@undarga/eslint-config');

/**
 * Framework-free package: the shared base config, nothing else.
 * No Nest rules — there is no database client here to guard.
 */
module.exports = base({ tsconfigRootDir: __dirname, project: ['./tsconfig.json'] });
