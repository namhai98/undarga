# Architecture Rules

Ten rules, each with the failure it prevents and where it is enforced. A rule
nobody can check is a preference; where a rule is machine-enforced, that is
noted, and where it is only a convention, that is noted too.

---

## 1. Business logic belongs in services, not controllers

A controller parses the request, calls one thing, and shapes the response. If it
contains an `if` about the domain, that `if` is in the wrong file.

**Why.** Logic in a controller can only be tested through HTTP, is invisible to
background jobs, and gets copy-pasted the moment a second entry point needs it.
The availability engine and the discount engine in particular must be callable
from a job, a queue worker and a test with no server running.

**Enforced by.** Convention and review. The probe controllers in
`apps/api/test/support/probe.module.ts` are the shape to copy: one repository
call each.

---

## 2. Tenant isolation is enforced server-side, in four layers

Every company-owned table carries `company_id`, and every query is filtered at
the **database**, not the application.

| Layer | Mechanism | Fails how |
|---|---|---|
| Database | PostgreSQL row-level security | Only if someone connects as a `BYPASSRLS` role |
| Referential | Composite foreign keys on `(company_id, id)` | Cannot fail — a cross-tenant reference is unrepresentable |
| ORM | Prisma extension that refuses unscoped queries | Only via `$queryRaw` |
| Test | 37 isolation tests asserting 404 for another tenant's ids | Catches regressions in the three above |

**Why four.** Any one of them can be bypassed by a sufficiently determined
mistake. All four failing silently at once is not a realistic accident.

**Enforced by.** `prisma/sql/001_hardening.sql` (RLS + the `tables_missing_rls`
CI view), `src/database/tenant-scope.guard-extension.ts`, the lint rules in
`packages/eslint-config/nest.js`, and `test/tenant-isolation.e2e-spec.ts`.

---

## 3. The frontend is not a security boundary

The web app hides buttons; the API decides. Every permission check that matters
runs server-side, and the browser copy exists only so the UI is not full of
controls that produce a 403.

**Why.** Everything shipped to a browser is editable by whoever receives it.
Treating a client-side check as protection means the protection is optional.

**Concretely.** No price arithmetic, no availability calculation and no
permission decisions in `apps/web`. Money arrives as
`{ amountMinor, currencyCode }` and is only formatted. The API re-checks every
permission regardless of what the UI rendered.

---

## 4. One database client, created in one place

`TenantPrismaService` (RLS enforced) and `PlatformPrismaService` (BYPASSRLS) are
the only two, both owned by `src/database`.

**Why.** A `new PrismaClient()` inside a feature module opens a second
connection pool that nobody accounts for, skips the tenant-scope extension, and
never gets `SET LOCAL app.current_company_id` — so it silently reads across
every tenant.

**Enforced by.** A lint rule that flags `PlatformPrismaService` outside an
explicit allowlist, with a reason recorded per entry in
`packages/eslint-config/nest.js`.

---

## 5. No microservices yet

One deployable NestJS application with hard internal module boundaries.

**Why.** The boundaries are the valuable part; the network hop is the cost.
Splitting now buys distributed transactions, partial-failure handling and
tracing infrastructure in exchange for problems this system does not have.

**How the option is kept open.** A module never queries another module's
tables — it calls a service or emits an event. That is the seam a service would
be extracted along, and it erodes silently without enforcement.

---

## 6. No circular module dependencies

If A imports B, B must not import A.

**Why.** Nest resolves cycles with `forwardRef`, which pushes a compile-time
error into a runtime one, and the runtime one appears as `undefined` on an
injected property at the first request rather than at boot.

**Concretely.** `TenancyContextModule` exists purely to break one:
`DatabaseModule` needs the request context, and `TenancyModule` needs the
database for membership lookups. The context provider was split into its own
module so neither imports the other.

---

## 7. Explicit dependencies over hidden global state

Constructor injection. Configuration through `AppConfig`, never
`process.env.X` scattered through the code.

**The one deliberate exception** is `RequestContextService`, which is ambient
by design (AsyncLocalStorage). It has to be: the tenant is needed in the
repository layer, and threading `companyId` through every signature is exactly
the parameter that gets forgotten. The trade is made safe by
`requireTenant()` throwing rather than returning null — there is no accessor
that quietly means "no tenant, carry on".

---

## 8. Do not duplicate shared types and utilities

The wire contract — response envelope, error codes, header names — lives in
`@undarga/shared` and both sides import it.

**Why.** The web app branches on `error.code === 'TENANT_UNRESOLVED'`. If the
backend renamed that code, a duplicated union would let both sides compile and
the branch would silently stop firing. Single-sourcing makes it a build error.

**What does NOT go there.** Business rules. Permission evaluation, tenant
resolution and pricing stay server-side. A rule a client can import is a rule a
client can be tempted to enforce — see rule 3.

---

## 9. No abstraction without a reason

The test: name the second caller. If there is only one, it is not an
abstraction, it is indirection.

**Applied here.** `packages/types` and `packages/shared` were merged into one
package, because two packages with four files between them is ceremony.
`@nestjs/terminus` was skipped for a hand-rolled 60-line health check, because
its default output includes driver error strings and this readiness probe is
unauthenticated.

**Where the cost was paid anyway.** `TenantResolver` is an interface with five
implementations, two of them switched off. That is justified: custom domains and
subdomains are known requirements, and the alternative is rewriting tenant
resolution when they land.

---

## 10. Do not modify unrelated functionality

Change what the task asks for. Leave the rest.

**Why.** A diff that touches thirty files for a two-file change cannot be
reviewed, and the unrelated twenty-eight are where the regression hides.

**Note.** Dependency upgrades are maintenance, not unrelated change — but they
belong in their own commit, verified against the full test suite, not smuggled
into a feature.

---

## Where the rules are checked

| Rule | Automated? | Where |
|---|---|---|
| 2 — tenant isolation | Yes | RLS, composite FKs, Prisma extension, 37 e2e tests |
| 4 — one database client | Yes | ESLint `no-restricted-syntax` + allowlist |
| 6 — no cycles | Partly | Nest fails at boot on an unresolvable cycle |
| 8 — no duplicated contract | Yes | The API's `ErrorCode` is imported from `@undarga/shared`; drift is a type error |
| 1, 3, 5, 7, 9, 10 | No | Review |
