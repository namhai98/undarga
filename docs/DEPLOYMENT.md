# Deployment and operations

How to run Undarga locally, build it, deploy it, and keep it running.
Security model and production settings: [SECURITY.md](SECURITY.md).
Database design: [DATABASE.md](DATABASE.md).

## 1. Local development

```bash
corepack enable                # pnpm version from package.json
pnpm install
cp .env.example .env           # development values; edit the database URLs if needed
docker compose up -d           # PostgreSQL 18 + Redis 8, bound to 127.0.0.1

pnpm db:deploy                 # migrate + hardening (roles, grants, RLS)
pnpm db:seed                   # reference data
pnpm db:seed:demo              # demo companies and users — DEVELOPMENT ONLY (truncates every table)

pnpm dev                       # API :3000, web :3001
```

`docker-compose.yml` runs only PostgreSQL and Redis; the apps run on the host.
Tests: `pnpm test` (unit), `pnpm test:e2e` (needs the `undarga_test` database,
created by the compose init script). See the README for details.

## 2. Configuration

| File | Purpose |
|---|---|
| `.env.example` | Development: every variable with a working local default |
| `.env.production.example` | Production: placeholders (`CHANGE_ME`) for every required value |

Configuration is validated when the API starts
(`apps/api/src/config/env.schema.ts`). Production refuses to start with, among
others: development secrets, `log`/`mock` email or SMS, the payment simulator,
`REDIS_REQUIRED=false`, empty or non-https `CORS_ORIGINS`,
`THROTTLE_ENABLED=false`, `TRUST_PROXY=true`, session-mode pooling, a
half-configured provider.

Secrets belong in your platform's secret store (or orchestrator secrets),
injected as environment variables at run time — never in the repository, an
image, or a build argument. `.env` and `.env.production` are gitignored and
excluded from Docker builds (`.dockerignore`).

The web app has one setting, `NEXT_PUBLIC_API_URL`, which Next inlines at
**build** time — so a web image is built per environment.

### Required production values

| Area | Variables |
|---|---|
| App | `NODE_ENV=production`, `CORS_ORIGINS`, `TRUST_PROXY`, `WEB_APP_URL`, `API_PUBLIC_URL` |
| Database | `DATABASE_URL` (app_tenant), `PLATFORM_DATABASE_URL` (app_platform), `MIGRATION_DATABASE_URL` (owner), `APP_TENANT_PASSWORD`, `APP_PLATFORM_PASSWORD` |
| Redis | `REDIS_URL` (with password, TLS where available), `REDIS_REQUIRED=true` |
| Secrets | `JWT_ACCESS_SECRET`, `TOKEN_HASH_PEPPER`, `SECRETS_ENCRYPTION_KEY` |
| Files | `STORAGE_DRIVER=s3` + `S3_*` (or `local` + a persistent volume) |
| Email/SMS | `EMAIL_PROVIDER=sendgrid` + `SENDGRID_*`, `SMS_PROVIDER=twilio` + `TWILIO_*`, `NOTIFICATION_WEBHOOK_BASE_URL` |
| Payments | `PAYMENT_PROVIDER=qpay` + `QPAY_*`, `PAYMENT_SIGNING_SECRET`, `PAYMENT_WEBHOOK_BASE_URL` |
| Calendar (optional) | `GOOGLE_CALENDAR_*` / `MICROSOFT_CALENDAR_*` pairs, `CALENDAR_OAUTH_REDIRECT_URL` |

Cookies: the refresh cookie is `HttpOnly`, `SameSite=Lax`, path-scoped, and
`Secure` whenever `NODE_ENV=production` — so production must be served over
HTTPS (terminate TLS at the proxy; HSTS is sent by both apps in production).

## 3. Images

```bash
# API (runtime)
docker build -f infrastructure/docker/api.Dockerfile -t REGISTRY/undarga-api:TAG .
# Database migration job (same Dockerfile, separate target)
docker build -f infrastructure/docker/api.Dockerfile --target migrate -t REGISTRY/undarga-api-migrate:TAG .
# Web (per environment)
docker build -f infrastructure/docker/web.Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.com/api/v1 -t REGISTRY/undarga-web:TAG .
```

- Multi-stage, frozen lockfile, pnpm pinned through `packageManager`; pin the
  `node:22-alpine` base by digest in your registry for byte-for-byte rebuilds.
- Both run as non-root users; both have a `HEALTHCHECK`.
- API: listens on 3000, health check = readiness. Local uploads go to
  `/app/storage` (a declared volume).
- Web: Next standalone server on 3001.

## 4. Deploying a release

Order matters; each step stops the release if it fails.

1. **CI green** on the commit (`.github/workflows/ci.yml`): lint, typecheck,
   unit, e2e, web tests, builds, audit, images. A deployment job must depend on
   it (`needs: [verify, images]`).
2. **Backup** the database if the release notes flag a risky migration (any
   migration that drops, renames or rewrites data) — see §6.
3. **Migrate**: run the migration image once, with the production
   environment, and wait for it to exit 0:
   `scripts/migrate-deploy.sh` → `prisma migrate deploy` (pending migrations
   only; never resets), `001_hardening.sql` (idempotent), reference-data seed
   (idempotent). It never seeds demo data; there is no flag for it.
4. **Roll the API** (and then the web app). Readiness gates traffic: an
   instance only receives requests once `/api/v1/health/ready` is 200.
   Shutdown is graceful (SIGTERM → background workers finish their current
   batch for up to 10 s → connections close). Allow ≥ 30 s stop grace.
5. **Verify**: `/api/v1/health/ready`, a staff sign-in, a public booking page.

Migrations are additive by convention. A destructive change ships in two
releases: first add the new shape and backfill (code reads both), then remove
the old one once nothing uses it. Never edit a migration that has run in
production; add a new one.

A single-host example of this order (healthy database and Redis → migrate
completes → API → web) is `infrastructure/docker/compose.production.example.yml`.
It is an example to adapt, not a tested deployment.

## 5. First Platform Admin

After the first successful migration:

```bash
# in the migration image (has the tooling), with the production environment
PLATFORM_ADMIN_EMAIL=ops@example.com \
PLATFORM_ADMIN_NAME="Operations" \
PLATFORM_ADMIN_PASSWORD='a long unique password' \
npx ts-node --transpile-only scripts/create-platform-admin.ts
```

It creates one `SUPER_ADMIN`, refuses if one already exists, and reads the
password only from the environment (unset it afterwards). Sign in at
`/platform`; companies are then provisioned from the console. Platform sign-in
does not yet enforce MFA — keep these accounts few, with long unique passwords.

## 6. Backup and restore

**Required in production**

- **PostgreSQL** holds everything. Use your provider's automated backups with
  point-in-time recovery (recommended), or at least a nightly logical dump:
  ```bash
  pg_dump --format=custom --no-owner --dbname "$MIGRATION_DATABASE_URL" -f undarga-$(date +%F).dump
  ```
  Keep copies off the database host; test a restore regularly.
- **`SECRETS_ENCRYPTION_KEY`** — back it up with the same care as the
  database. Without it, stored provider and calendar credentials cannot be
  decrypted (they would have to be re-entered).
- **File storage** — S3: enable bucket versioning (and replication if
  required). Local driver: back up the `/app/storage` volume with the database.

**Restore**

1. Stop the API (and web) instances.
2. Restore into an empty database:
   `pg_restore --no-owner --dbname "$MIGRATION_DATABASE_URL" undarga-YYYY-MM-DD.dump`
3. Run the migration job (§4.3). It re-applies grants, row-level security and
   role passwords — roles live at the cluster level, so this step is not
   optional after a restore.
4. Start the API; check readiness; spot-check a company.

**Redis** holds only short-lived state: rate-limit windows, revoked-session
markers (≤ 15 min), caches. It needs no backup; AOF persistence keeps
revocations across a Redis restart (optional improvement).

## 7. Health checks and monitoring

| Endpoint | Meaning |
|---|---|
| `GET /api/v1/health` | Liveness: the process answers |
| `GET /api/v1/health/ready` | Readiness: database reachable (and Redis, when required); 503 otherwise |

Logs: `LOG_FORMAT=json` (production default) writes one JSON object per line —
`level`, `timestamp`, `context`, `message`, `pid`. One line per request
(`context: "HTTP"`, method, path, status, ms, request id, actor kind, company
slug). Never bodies, query strings, headers, tokens or passwords. Every error
response carries a `requestId` that appears in the log line.

No monitoring provider is configured in the repository. Ship stdout to your log
platform and alert on:

| Signal | Query (JSON logs) |
|---|---|
| Unhandled errors | `level = "error"` and `context = "DomainExceptionFilter"` |
| Background jobs | `level = "error"` and `context` in `NotificationSchedulerService`, `CalendarSchedulerService`, `FileCleanupService`, `SubscriptionSchedulerService` |
| Payments | `context` in `PaymentWebhooksService`, `PaymentTransactionsService`, `QPayProvider` |
| Notification delivery | `context` in `NotificationWorkerService`, `NotificationDispatcherService` |
| Platform sign-in without MFA | `context = "AuthService"` and message contains `without MFA` |
| Readiness | `/api/v1/health/ready` ≠ 200 (from your uptime monitor) |

In the app: failed notifications are listed per company
(`GET /companies/:id/notifications?status=FAILED`); rejected or failed payment
webhooks in the platform console (`GET /platform/payments/webhook-events`);
calendar sync errors per connection (`/calendar` page).

## 8. Reliability

**Required safeguards (all in place)**

- Restart policy on API and web (`restart: unless-stopped` or your
  orchestrator's equivalent). State lives in PostgreSQL, so a crashed instance
  loses nothing: background work is claimed per row and picked up again —
  notifications stuck in `SENDING` are recovered automatically, calendar jobs
  retry, payment webhooks are idempotent and providers redeliver.
- Readiness gates traffic; graceful shutdown drains workers.
- Every outbound provider call has a timeout (QPay, SendGrid, Twilio, Google,
  Microsoft, S3).
- Rate limits and session revocation are shared through Redis across replicas
  (production requires Redis).
- Database pooling: Prisma pools per instance; behind PgBouncer use
  transaction mode only (`DB_POOLING_MODE=transaction`) — session mode leaks
  tenant context and is refused.

**Optional improvements**

- Point-in-time recovery for PostgreSQL (strongly recommended).
- Redis AOF persistence; a managed Redis with TLS.
- An error tracker (Sentry or similar) alongside log alerts.
- Bounded concurrency for notification sending (currently sequential per
  instance; mind Twilio's per-number rate).
- Platform MFA (see SECURITY.md).

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| API exits at start with `Invalid environment configuration` | The message lists each variable; see §2 |
| `DATABASE_URL connects as …, which has BYPASSRLS` | `DATABASE_URL` must use `app_tenant`, not the owner |
| Readiness 503, `redis down` | Redis unreachable with `REDIS_REQUIRED=true`; check `REDIS_URL`/password |
| Every client rate-limited together | `TRUST_PROXY` not set behind a load balancer |
| Refresh/logout 403 "allowed origin" | Web origin missing from `CORS_ORIGINS` |
| Migration job: `Refusing to set a default role password` | Set `APP_TENANT_PASSWORD` and `APP_PLATFORM_PASSWORD` |
| Migration job fails part-way | Fix the cause and re-run: applied migrations are skipped, hardening and seed are idempotent. A migration that failed mid-way must be resolved first (`prisma migrate resolve`) — restore from the pre-release backup if in doubt |
| Web shows "cannot reach the API" | `NEXT_PUBLIC_API_URL` baked into the image is wrong; rebuild the web image |
| Uploads lost after redeploy (local storage) | `/app/storage` is not on a persistent volume |

## 10. CI

`.github/workflows/ci.yml` runs on pushes to `main`, pull requests and on
demand: install (frozen lockfile), shared build, Prisma validate + generate,
lint, typecheck, API unit tests, test database migrate + harden, the deploy
procedure against an empty database, API e2e (PostgreSQL 18 with RLS + Redis
8), web tests, production builds, `pnpm audit --prod` (fails on critical,
warns on the rest), then — only if all of that passed — the three Docker
images. It never pushes images and never deploys.
