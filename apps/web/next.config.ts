import path from 'node:path';
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
   * A self-contained server for the production image
   * (infrastructure/docker/web.Dockerfile runs .next/standalone/apps/web/server.js).
   * Tracing starts at the monorepo root so workspace packages are included and
   * the output keeps the repository layout.
   */
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),

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

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders() }];
  },
};

/**
 * Security headers for every page.
 *
 * - No framing at all: the dashboard is a target for clickjacking (a hidden
 *   "Cancel appointment" or "Refund" button under a decoy page).
 * - A Content-Security-Policy that only lets the page talk to itself and the
 *   API. Next's App Router injects inline bootstrap scripts, so script-src
 *   needs 'unsafe-inline' without a nonce-based middleware; the rest of the
 *   policy (no foreign scripts, no plugins, no foreign form targets, no
 *   <base> hijack) still applies. Development additionally needs eval and a
 *   websocket for hot reload.
 * - HSTS only in production, where the site is served over HTTPS.
 */
function securityHeaders(): Array<{ key: string; value: string }> {
  const production = process.env.NODE_ENV === 'production';
  const api = apiOrigin();
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${production ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    // Images come from the API (public files) or object storage it signs for.
    `img-src 'self' data: blob: https:${api ? ` ${api}` : ''}`,
    "font-src 'self' data:",
    `connect-src 'self'${api ? ` ${api}` : ''}${production ? '' : ' ws: wss:'}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  return [
    { key: 'Content-Security-Policy', value: csp },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    ...(production
      ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
      : []),
  ];
}

/** The API's origin, from NEXT_PUBLIC_API_URL (which includes a path). */
function apiOrigin(): string | null {
  try {
    return process.env.NEXT_PUBLIC_API_URL ? new URL(process.env.NEXT_PUBLIC_API_URL).origin : null;
  } catch {
    return null;
  }
}

export default nextConfig;
