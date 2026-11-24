# Security

The security model and the hardening done in Task #28. For tenant isolation in
depth see [MULTI-TENANCY.md](MULTI-TENANCY.md); for authentication flows see
[AUTHENTICATION.md](AUTHENTICATION.md).

## Model in brief

- **Deny by default.** Global guards run in order: rate limit → JWT
  (`@Public()` to opt out) → tenant (company resolved and membership checked
  in the database on every request) → permission (`@RequirePermission`).
- **Three token realms** — staff, platform, customer — separated by `aud`. A
  route accepts the realm it declares; platform operators reach company data
  only on routes that opt in, only for a company they name, and only with an
  explicit data permission.
- **Tenant isolation in the database.** Row-level security on every
  company-owned table (`001_hardening.sql`), the app connects as a role
  without `BYPASSRLS` (checked at boot), and a Prisma guard refuses queries
  without a `company_id` filter. Another company's id is a 404, never a 403.
- **Credentials.** argon2id; 12–512 character passwords; refresh tokens are
  opaque, HMAC-hashed at rest, rotated on use, with reuse detection that
  revokes the family; access tokens are 15-minute HS256 JWTs.
- **Inputs.** Strict zod schemas on every body and query; unknown fields
  rejected or stripped; list limits capped. No unsafe raw SQL.
- **Files.** Content-sniffed images only (JPEG/PNG/WebP), re-encoded, metadata
  stripped; private files via short-lived signed URLs; `nosniff`.
- **Webhooks.** Signatures verified over the raw body with constant-time
  comparison; replays rejected; processing idempotent.
- **Errors.** Unknown errors are a generic 500; stack traces and database
  messages are logged, never returned. Logs carry no bodies, tokens or query
  strings.

## Task #28: found and fixed

| Issue | Fix |
|---|---|
| Behind a load balancer every client shared the balancer's IP: per-IP login limits could lock everyone out, audit IPs were wrong | `TRUST_PROXY` (hop count or subnets; `true` refused) |
| Rate-limit counters and session revocation were per process: N replicas allowed N× the rate, and a logout or password change reached other replicas only when the token expired | Both in Redis (`RedisThrottlerStorage`, `SessionDenyList`), with a per-process fallback during a Redis outage |
| Platform Admin login: no account lockout, default 300/min limit | Lockout after 5 failures for 15 min (`platform_user.failed_login_count`, `locked_until`), 5/min per IP |
| Vulnerable dependencies: Next.js (RCE in `next/og`, SSRF, cache poisoning), proxy-addr (IP spoofing), multer (DoS), sharp | Upgraded / pinned patched versions; `pnpm audit --prod` clean |
| Web app sent no security headers | CSP, `X-Frame-Options: DENY`, nosniff, referrer and permissions policies, COOP, HSTS in production (`next.config.ts`) |
| No `.dockerignore`: `.env` was sent into the Docker build | `.dockerignore` excludes env files, git and local state |
| Swagger on by default in production; throttling could be switched off; CORS origins unvalidated | Swagger off in production unless set; `THROTTLE_ENABLED=false`, non-https or malformed CORS origins refused |
| JWT algorithm not pinned | HS256 only, for signing and verifying |
| Cookie-authenticated refresh/logout drivable from other origins | Origin must be in `CORS_ORIGINS` (or same-origin) |
| Invitation endpoints on the default rate limit | 20/min preview, 10/min accept |
| Dev Postgres and Redis listened on all interfaces | Bound to 127.0.0.1 in `docker-compose.yml` |
| (Found in #30) In production the hardening script would give the BYPASSRLS `app_platform` role its development password when `APP_PLATFORM_PASSWORD` was unset | Refuses unless both role passwords are set |

API responses also carry a strict CSP (`default-src 'none'`) and
`Cache-Control: no-store`. The shared HTTP setup lives in
`src/bootstrap/configure-app.ts` and is used by the e2e harness too.

Tests: `test/security.e2e-spec.ts` (headers, unauthenticated access, forged /
expired / `alg:none` tokens, platform separation, permissions, cross-company
ids, mass assignment, sensitive response data, lockout, rate limits,
revocation across two app instances, CSRF Origin check) and
`src/config/env.schema.spec.ts`.

## Production configuration

Required or strongly recommended:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | number of proxies in front of the API (one load balancer: `1`) |
| `CORS_ORIGINS` | exact `https://` origins of the web app |
| `REDIS_REQUIRED` | `true` (enforced) |
| `JWT_ACCESS_SECRET` | ≥ 32 random characters |
| `TOKEN_HASH_PEPPER` | ≥ 16 random characters |
| `SECRETS_ENCRYPTION_KEY` | 32 random bytes, base64 (provider and calendar credentials) |
| `SWAGGER_ENABLED` | leave unset (off) unless the API is deliberately public |
| `THROTTLE_ENABLED` | leave unset (on; `false` is refused) |

Secrets come from the environment at run time — never from files in the
image. See `.env.example` for every variable.

## Dependency advisories after #28

Published after Task #28 and patched in Task #29: Next.js ≤ 16.4.0 (two
unauthenticated remote code execution issues, a Server Action DoS) → 16.4.1;
body-parser < 2.4.0 and multer < 2.5.0 (DoS) → pinned patched versions.

## Remaining risks

- **zod 3** has a high-severity advisory (memory exhaustion validating
  oversized constrained input) fixed only in zod 4 — a major upgrade touching
  every DTO and `nestjs-zod`, so it is a task of its own. Meanwhile request
  bodies are capped by Express's default 100 KB JSON limit (Nest's default
  parser), which bounds the exposure.
- **deepmerge ≤ 4.3.1** (low, prototype poisoning in `mergeObject`) comes in
  through `nestjs-zod`; no fixed version exists yet. Upgrade when one does.
  (`qs` was patched to 6.16.2 in Task #30.)
- **Platform MFA is not enforced** — sign-ins without enrolment are logged as
  errors. Enrolment and verification are a feature of their own.
- **The web CSP allows inline scripts**: the App Router needs them unless a
  nonce-issuing middleware is added.
- **Dev-tool advisories** (vitest 2, vite 5, jest helpers) need a vitest major
  upgrade; they never ship to production.
