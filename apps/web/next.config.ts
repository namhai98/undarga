import type { NextConfig } from 'next';

/**
 * Environment comes from the repository-root `.env`, loaded by `dotenv-cli` in
 * this package's scripts (`dotenv -e ../../.env -- next ...`).
 *
 * WHY NOT `loadEnvConfig` FROM `@next/env`
 *
 * The tidy-looking option is to call `loadEnvConfig(repoRoot)` here. It does
 * populate `process.env` in this process, but Turbopack snapshots the
 * environment for `NEXT_PUBLIC_*` inlining before that side effect is visible
 * to it, so the build compiles `process.env.NEXT_PUBLIC_API_URL` to
 * `undefined` and fails at prerender with a misleading "Required" error.
 * Loading the file before Node starts sidesteps the ordering problem entirely,
 * and matches how `apps/api` already reads the same file.
 *
 * One `.env` for the whole monorepo: per-app files drift, and the classic
 * symptom is the web app pointing at a stale API port for a week.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * The browser allow-list.
   *
   * A variable reaches the client bundle only if it appears BOTH here and in
   * the schema in `lib/env.ts`. Two deliberate steps, so a server secret
   * cannot arrive in the browser by someone prefixing it with `NEXT_PUBLIC_`.
   */
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? '',
  },

  /**
   * `@undarga/shared` is a workspace package published as compiled CommonJS.
   * Listing it here lets Next bundle it rather than treat it as an external
   * dependency it cannot resolve.
   */
  transpilePackages: ['@undarga/shared'],

  // The build must not pass with type errors. Stated explicitly so nobody
  // "temporarily" flips it.
  //
  // There is no "eslint" key any more: Next 16 removed "next lint", so linting
  // is a separate "pnpm lint" step rather than part of the build.
  typescript: { ignoreBuildErrors: false },

  // Do not advertise the framework version to every visitor.
  poweredByHeader: false,
};

export default nextConfig;
