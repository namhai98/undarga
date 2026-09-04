const { nest } = require('@undarga/eslint-config');

/**
 * Backend lint config.
 *
 * The tenant-safety rules (no raw SQL, no BYPASSRLS client outside the
 * allowlist) live in @undarga/eslint-config/nest.js so they are versioned with
 * the reasoning behind them, and so a second backend service would inherit
 * them rather than reinvent them.
 */
module.exports = nest({ tsconfigRootDir: __dirname, project: ['./tsconfig.json'] });
