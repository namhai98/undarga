# Multi-Tenant Foundation — Implementation Notes

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) and [DATABASE.md](./DATABASE.md).
This describes what was **built**, not what was planned.

> **Not yet verified by execution.** No Node, npm, Docker or PostgreSQL is installed on the
> machine this was written on, so nothing here has been compiled, generated, or run. See
> §7 for exactly what that leaves unproven and the commands to close the gap.

---

## 1. The request path

```
HTTP request
     │
     ▼
RequestContextMiddleware        opens AsyncLocalStorage for the whole request
     │                          (must be middleware — only middleware can wrap
     │                           the remainder of the request in a callback)
     ▼
JwtAuthGuard                    verifies the token, checks the audience against
     │                          the route's realm, checks the session deny-list,
     │                          → attachActor()
     ▼
TenantGuard                     TenantResolverChain  → "which company is named?"
     │                          MembershipService    → "may this actor enter it?"
     │                          → attachTenant()
     ▼
PermissionGuard                 permissions from THIS membership
     │
     ▼
Controller  →  Service  →  TenantScopedRepository
                                 companyId from context, merged into every where
                                        │
                                        ▼
                           TenantPrismaService
                                 BEGIN; SET LOCAL app.current_company_id; …
                                        │
                                        ▼
                              PostgreSQL + RLS
```

Guard order is registered in `app.module.ts` and is load-bearing: each stage consumes what
the previous one produced.

---

## 2. Decisions worth knowing before reading the code

### 2.1 AsyncLocalStorage, not `Scope.REQUEST`

Request-scoped Nest providers are contagious — everything that injects one becomes
request-scoped too, and the tenant context is needed all the way down in the repository
layer. They also do not exist in a BullMQ worker, a cron tick, or a WebSocket frame, and
this system needs tenant context in all three.

ALS costs one thing: the store is implicit rather than injected. That is why
`requireTenant()` throws instead of returning null.

### 2.2 Resolution and authorization are different objects

`TenantResolverChain` answers *which company is named*. `MembershipService` answers *may
this actor enter it*, and is the only thing in the codebase that constructs a
`TenantContext`.

Because nothing else can build one, holding a `TenantContext` anywhere is itself proof the
check ran. It is also the structural answer to "do not trust a client-supplied
`companyId`": the id from the URL is *read* eagerly and *trusted* never.

### 2.3 Deny by default

All three guards are global. A route with no decorators requires authentication, requires
a company, and is reachable. Opting out is explicit: `@Public()`, `@NoTenant()`,
`@PlatformOnly()`, `@AllowPlatformAccess()`.

The inverse ordering — scope only the routes that ask for it — fails in the worst
direction. Someone adds `GET /reports/revenue`, forgets a decorator, and ships an endpoint
that reads every company's revenue. This way the same mistake is a 500 on the first
request in development, with the missing decorator named in the message.

### 2.4 The database layer asserts, it does not inject

Three layers, and only the deepest is a guarantee:

| Layer | What it does | If bypassed |
|---|---|---|
| `TenantScopedRepository` | Merges `companyId` into every filter | Nothing breaks — it is the paved road, not a fence |
| Prisma extension | **Refuses** any query on a company-owned model with no `companyId` in its filter | Loud 500 naming the model and operation |
| PostgreSQL RLS | Returns no rows | Silent, correct, final |

The tempting alternative is a Prisma middleware that quietly *adds* `companyId` to every
query. Rejected, for four reasons: it makes emitted SQL unpredictable; it covers only
top-level `where` and silently misses nested writes and raw SQL; it hides bugs instead of
surfacing them; and it cannot tell "forgot the tenant" from "deliberately cross-tenant".

Asserting means correct code passes through untouched and the SQL is exactly what was
written.

### 2.5 404, never 403, for another tenant's data

A 403 confirms the row exists. With UUIDv7 primary keys it also leaks a creation
timestamp. So `TenantNotFoundError` and `ResourceNotFoundError` are both 404 with an
identical body, and the isolation suite asserts that a real foreign id and a fictional one
produce byte-identical responses.

The exceptions are deliberate and narrow: an *inactive membership* is a 403 (the user
knows they were invited), and a *suspended company* is a 403 (they are already inside).

### 2.6 Platform access is opt-in per route

There is no `if (user.isAdmin) skipFilter` anywhere, and it is not expressible: `Actor` is
a discriminated union, so widening requires matching on `kind`, which shows up in review.

An operator gets a tenant context only when **all** of these hold:

1. The route carries `@AllowPlatformAccess()`.
2. They named a company explicitly (path or `X-Company-Id`) — never implicitly.
3. They hold `platform:company:data:read` or `:write`, which no company role can contain.

Even then they are scoped to **one company per request**, through the same RLS-bound
connection a member would use. The `BYPASSRLS` pool is not involved.

---

## 3. Tenant resolution strategies

Priority order, all config-gated:

| Resolver | Source | Explicit? | Default |
|---|---|---|---|
| `route-param` | `:companyId` / `:companySlug` | yes | on |
| `active-company-claim` | verified `act` claim | no | on |
| `header` | `X-Company-Id` / `X-Company-Slug` | yes | on |
| `custom-domain` | `Host` → verified `company_domain` | yes | **off** |
| `subdomain` | `acme.booking.app` → slug | yes | **off** |

**Explicit beats implicit** — that is what makes `/companies/:companyId/…` work for a
multi-company user without switching first.

**Two disagreeing explicit sources is a hard 400.** Precedence between them would be a
confused-deputy generator: an attacker who can influence one channel but not the other
gets to steer the request.

The two host-based resolvers are complete and unit-tested but disabled, because the
things they depend on do not exist yet: DNS TXT verification and on-demand TLS for custom
domains, wildcard DNS for subdomains. Enabling them is a config change.

---

## 4. Multiple memberships

Nothing binds a user to one company:

- Login returns every membership and selects a **default** active company so a
  single-company user never sees a picker.
- The active company lives in the token, so it is per session — the same person can be
  signed in to two companies in two browsers.
- `POST /auth/switch-company` issues a **new** token pair and retires the old session, so
  a token is valid for exactly one company and a leaked one cannot be replayed against
  the new company.

The claim is still only a hint. `TenantGuard` re-validates membership on every request, so
a revoked membership stops working within the membership cache TTL (default 60s), or
immediately if the revocation happens on the same replica.

---

## 5. Background jobs

Job payloads extend `TenantJobPayload` and carry `companyId`, because by the time a worker
runs, the request that created the job is gone and its ALS context was torn down.

`TenantJobRunner.run()` does two things:

1. Validates the payload names a live company, and builds a `SYSTEM`-actor context for it.
   A payload with no company throws rather than running unscoped.
2. Gives the handler `assertBelongsToCompany`, because a job payload is **data at rest** —
   it sat in Redis for hours, and the id in it may now belong to someone else.

`TenantJob` is a structural interface that BullMQ's `Job` satisfies, so no queue library is
a dependency of tenant safety and the whole thing is testable with an object literal.

---

## 6. Audit

`AuditService.record()` takes what happened; the company, actor, impersonation grant and
request id come from the ambient context. There is no parameter with which to attribute an
action to the wrong company.

- `companyId` present → happened inside a tenant.
- `companyId` null → happened to the platform, or to a company from outside it.

RLS makes NULL-company rows invisible to tenants, so platform rows are written on the
platform connection.

Rows are hash-chained per company under a transaction-scoped advisory lock. That
serialises audit writes for one company — a real cost on the busiest tenant, disable-able
with `AUDIT_HASH_CHAIN=false`. The better answer (chain asynchronously off the outbox) is
a follow-up, not built.

---

## 7. What is verified, and what is not

### Runnable with no database

```bash
pnpm install          # also runs `prisma generate` — no DB needed
pnpm --filter @undarga/api test
```

`src/**/*.spec.ts` — 8 suites covering the request context, the resolver chain, membership
authorization, both guards, the scoped-query assertion, the repository base class, and the
job runner.

### Requires PostgreSQL

```bash
docker compose up -d postgres-test
cd apps/api
pnpm prisma migrate dev --name init     # generates the structural migration
pnpm db:harden                          # applies prisma/sql/001_hardening.sql
pnpm db:seed
pnpm test:e2e
```

`test/tenant-isolation.e2e-spec.ts` — the twelve scenarios from the brief, plus the nested
resource attack and the ambiguity case.

`test/support/global-setup.ts` **refuses to run** if the hardening SQL has not been applied
or if `app_tenant` has `BYPASSRLS`. Without that check most of these assertions would pass
on the repository layer alone, and the green run would be a lie about the property that
actually matters.

### Not verified at all

Nothing in this directory has been compiled or executed. In particular: the Prisma schema
has never been through `prisma validate`, the initial migration has never been generated,
and no test has ever run. Treat the first `pnpm install && pnpm test` as part of the
review, not as a formality.
