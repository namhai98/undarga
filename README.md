# Undarga — Multi-Tenant Booking Platform

A SaaS booking platform where many independent companies each run multiple
branches, staff, services and appointments, with strict data isolation between
them.

**Status: foundation.** The monorepo, the API, the database with tenant
isolation, and the web shell are in place and verified. No booking features are
built yet — no appointments, availability, payments, promotions, gift cards or
notifications.

---

## Requirements

| | Version | Notes |
|---|---|---|
| Node.js | ≥ 20.11 | Developed and verified on 24.19 |
| pnpm | ≥ 9 | `corepack enable`, or `npm i -g pnpm@9` |
| Docker + Compose | any current | PostgreSQL and Redis. A local install works too — see below |
| PostgreSQL | 16 – 18 | Verified on 18.6 |
| Redis | 7 – 8 | Optional in development |

---

## Quick start

```bash
pnpm install
cp .env.example .env          # then edit the three DATABASE_URLs
docker compose up -d          # PostgreSQL + Redis

pnpm db:deploy                # migrate, then apply the hardening SQL
pnpm db:seed                  # currencies, timezones, permissions, plans
pnpm db:seed:demo             # two demo companies (development only)

pnpm dev                      # API on :3000, web on :3001
```

Then open <http://localhost:3001>. The card on that page reports whether the
browser can reach the API and whether PostgreSQL and Redis are up — if it is
green, the whole stack is wired.

### Without Docker

Point the URLs in `.env` at any PostgreSQL you have and create the two
databases yourself:

```bash
createdb undarga && createdb undarga_test
pnpm db:deploy && pnpm db:seed
```

Redis is genuinely optional locally: `REDIS_REQUIRED=false` lets the API start
without it and report it down on the readiness probe. Production refuses to
start that way.

### Windows: Docker inside WSL2

The stack has been verified with the Docker engine running inside WSL2 rather
than Docker Desktop. Two things behave differently there, and both cost time
to diagnose from the symptoms alone:

**A Windows service on a port beats the container.** WSL2 forwards
`localhost:<port>` from Windows into the distro only when Windows itself has
nothing bound to that port. So if you also have a native PostgreSQL service
running, `localhost:5432` reaches the native one and the container is
effectively invisible from Windows — no error, no conflict, just a different
database than the one you think you are looking at. Check with:

```bash
psql -h 127.0.0.1 -U postgres -tAc "select current_setting('data_directory')"
```

A container answers from `/var/lib/postgresql/18/docker`; a native Windows
install answers from `C:/Program Files/PostgreSQL/18/data`. Stop the native
service, or accept that the container is WSL-only.

**Only one thing may hold 6379.** A Redis installed in the distro with `apt`
is enabled at boot, and the container carries `restart: unless-stopped`. Both
start on boot and one of them loses the port at random. Pick one — if you use
compose, `sudo systemctl disable --now redis-server`.

---

## Commands

Run from the repository root; Turborepo fans them out and caches.

| Command | Does |
|---|---|
| `pnpm dev` | Both apps in watch mode |
| `pnpm build` | Build every package and app |
| `pnpm lint` | ESLint across the workspace |
| `pnpm typecheck` | `tsc --noEmit` everywhere |
| `pnpm test` | Unit tests (no database needed) |
| `pnpm test:e2e` | Integration + tenant-isolation tests (needs the test database) |
| `pnpm format` | Prettier write |
| `pnpm format:check` | Prettier check, for CI |

Single app: `pnpm dev:api`, `pnpm dev:web`, or
`pnpm --filter @undarga/api <script>`.

### Database

| Command | Does |
|---|---|
| `pnpm db:migrate` | Create and apply a migration (development) |
| `pnpm db:deploy` | Apply migrations, then the hardening SQL |
| `pnpm db:harden` | Apply RLS, exclusion constraints, CHECKs, partitions |
| `pnpm db:seed` | Reference data — currencies, timezones, permissions, plans |
| `pnpm db:seed:demo` | Two demo companies with users (development only) |
| `pnpm db:reset` | Drop, re-migrate, harden, re-seed |
| `pnpm db:studio` | Prisma Studio |

`db:harden` applies everything Prisma cannot express — row-level security,
exclusion constraints, generated columns, partial unique indexes, table
partitioning. It is idempotent and **must** run after every migration.

> **`prisma db push` is banned, including locally.** It does not see any object
> in `prisma/sql/001_hardening.sql` and will silently drop your row-level
> security policies.

---

## Layout

```
apps/
  api/                NestJS. REST on /api/v1, OpenAPI at /api/docs
    src/
      auth/           authentication, sessions, three token realms
      tenancy/        tenant context, resolvers, membership validation
      authz/          permission catalog and guards
      database/       both Prisma clients + the tenant-scoped repository
      redis/          cache, locks, queues (infrastructure only so far)
      audit/          hash-chained audit trail
      jobs/           tenant-safe background job runner
      health/         liveness and readiness
      common/         errors, filters, interceptors, middleware, pipes
      config/         validated, namespaced configuration
    prisma/           schema, migrations, hardening SQL, seeds
    test/             isolation and foundation e2e suites

  web/                Next.js App Router, Tailwind 4, shadcn/ui
    app/              routes only
    features/         vertical slices — see apps/web/features/README.md
    components/ui/    shadcn primitives
    services/         API client, token store, typed services
    providers/        React Query and future auth providers
    lib/ utils/ hooks/ types/

packages/
  shared/             the wire contract: envelope, error codes, headers, money
  tsconfig/           base / nest / next / library TypeScript configs
  eslint-config/      shared flat configs, incl. the tenant-safety lint rules

infrastructure/docker/  production Dockerfiles, Postgres init
docs/                   architecture, database design, rules
```

### Why `apps/web` is sliced by feature

Grouping by technical kind (`components/`, `hooks/`, `services/`) scatters one
change across three folders. Each folder under `features/` owns one product area
end to end and is imported only through its `index.ts`. See
`apps/web/features/README.md`.

---

## Environment

One `.env` at the repository root; both apps read it. Copy it from
`.env.example`, which documents every variable.

Three database URLs, and the split is a security control:

| Variable | Role | Used by |
|---|---|---|
| `DATABASE_URL` | `app_tenant` — **RLS enforced** | Every request |
| `PLATFORM_DATABASE_URL` | `app_platform` — **BYPASSRLS** | Four allowlisted files |
| `MIGRATION_DATABASE_URL` | schema owner | Migrations and seeds only |

The API **refuses to start** if `DATABASE_URL` connects as a role that can
bypass row-level security — otherwise the app works perfectly and every
isolation test passes for the wrong reason.

Configuration is validated at boot by a zod schema
(`apps/api/src/config/env.schema.ts`). A missing secret, a half-configured SMTP
block, or session-mode pooling in production all fail with a message naming the
variable rather than surfacing later as `undefined`.

Only `NEXT_PUBLIC_API_URL` reaches the browser. It is inlined into the bundle
and is public by definition; nothing else may be prefixed `NEXT_PUBLIC_`.

---

## Multi-tenancy in one screen

```
Request → JwtAuthGuard      who is asking
        → TenantGuard       which company, validated against membership
        → PermissionGuard   what they may do in THAT company
        → Controller → Service → TenantScopedRepository
                                 → SET LOCAL app.current_company_id
                                 → PostgreSQL row-level security
```

All three guards **deny by default**: an endpoint with no decorators requires
authentication, requires a company, and is scoped. Forgetting a decorator makes
a route unreachable rather than unscoped.

Another company's record returns **404, never 403** — a 403 confirms it exists.

Full detail in [docs/MULTI-TENANCY.md](docs/MULTI-TENANCY.md).

---

## Documentation

| | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, module structure, phased plan |
| [docs/DATABASE.md](docs/DATABASE.md) | 78-table schema, ERD, isolation strategy |
| [docs/MULTI-TENANCY.md](docs/MULTI-TENANCY.md) | How isolation is implemented and enforced |
| [docs/ARCHITECTURE-RULES.md](docs/ARCHITECTURE-RULES.md) | Ten rules, why each exists, how each is checked |

---

## API

- REST under `/api/v1`
- OpenAPI UI at <http://localhost:3000/api/docs> (`SWAGGER_ENABLED`, off in production)
- Success: `{ "data": …, "meta": { "requestId": "…" } }`
- Error: `{ "error": { "code": "…", "message": "…", "requestId": "…" } }`

Error codes are shared with the frontend through `@undarga/shared`, so a
renamed code is a build error rather than a branch that stops firing.

---

## Security notes

- Secrets never enter the repository. `.env` is gitignored; only `.env.example`
  with placeholders is tracked.
- Passwords are argon2id. Refresh tokens are opaque, HMAC-peppered, and rotate
  with reuse detection — there is no refresh JWT to steal.
- Tokens are held in memory in the browser, never in `localStorage`. A reload
  currently signs you out; the fix is an `HttpOnly` cookie and is listed as an
  open decision.
- The audit trail is append-only and hash-chained per company.
