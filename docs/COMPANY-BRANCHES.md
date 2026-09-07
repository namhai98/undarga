# Company & Branch Management

Administering a company from inside it, and the branches it operates.

Companion to [PROVISIONING.md](./PROVISIONING.md), which is how a company comes
to exist. This describes what was **built**, not what was planned.

---

## 1. Endpoints

Everything is nested under `/companies/:companyId`, and that id is validated
against the caller's memberships before any handler runs.

| Method | Path | Permission |
|---|---|---|
| `GET` | `/companies/:companyId` | `company:read` |
| `PATCH` | `/companies/:companyId` | `company:write` |
| `DELETE` | `/companies/:companyId` | `company:write` |
| `POST` | `/companies/:companyId/deactivate` | `company:write` |
| `GET` `PATCH` | `/companies/:companyId/settings` | `settings:read` / `settings:write` |
| `GET` | `/companies/:companyId/branding` | `settings:read` |
| `PATCH` | `/companies/:companyId/branding` | `settings:branding:write` |
| `GET` `POST` | `/companies/:companyId/branches` | `branch:read` / `branch:write` |
| `GET` `PATCH` `DELETE` | `/companies/:companyId/branches/:branchId` | `branch:read` / `branch:write` |
| `GET` `PATCH` | `/…/branches/:branchId/settings` | `branch:read` / `branch:write` |
| `GET` `PUT` | `/…/branches/:branchId/business-hours` | `branch:read` / `branch:write` |

Every mutation also carries `@RequiresWrite()`, so a company in a read-only
operational state (suspended, or in a billing grace period) is refused in the
guard chain rather than in each service.

**There is no `POST /companies`.** Companies are provisioned by a platform
operator — see §8.

---

## 2. Neither id in the path is trusted

Two ids arrive from the client and both are treated as hostile:

**`companyId`** goes to `RouteParamTenantResolver`, then `MembershipService`
checks it against the caller's memberships. A company they do not belong to is
**404**, not 403 — the endpoint will not confirm that the company exists. The
services then take the company from the resolved request context, never from
the parameter.

**`branchId`** is only ever used inside a filter that also carries the resolved
company. There is no code path that looks a branch up by id alone, so
`branch.companyId === currentCompany.id` holds by construction rather than by
anyone remembering to check it.

Underneath, two more layers apply without anyone asking: RLS on the tenant
connection, and the composite foreign key `(company_id, branch_id)` which makes
a settings row or an opening-hours row attached to another tenant's branch
structurally unrepresentable.

A test asserts that a foreign branch id presented through your **own** company
path returns the same answer as an id that never existed.

---

## 3. Fields a company cannot change about itself

`PATCH /companies/:id` uses a strict schema — an unknown key is a 400, not a
silent drop, so an attempt is visible to the client rather than a no-op it
retries differently. Four omissions are deliberate:

| Field | Why |
|---|---|
| `slug` | A tenant-resolution key, cached by `TenantDirectoryService` and baked into saved links. Changing it is a migration. |
| `status` | Lifecycle, with its own endpoint so the transition can be validated and audited as one. |
| `currencyCode` | Every stored amount is in it. Changing it would silently reinterpret history. |
| `id` | Obviously. |

The same applies to branding: `logoFileId` is absent until the file module
exists, and **`customCss` is absent for a security reason** — arbitrary CSS on
a page that renders customer data is an exfiltration primitive, since attribute
selectors plus `background-image` can read input values out one character at a
time.

---

## 4. Slugs

Normalised, URL-safe, unique, and never silently rewritten.

`slugify()` exists and turns `My Beauty Studio` into `my-beauty-studio`, folding
diacritics rather than dropping them. It only ever **suggests**: nothing calls
it to rewrite a slug a caller supplied. A caller either sends a valid slug or
gets a 400 naming the problem, because a slug that quietly differs from what was
typed is a support ticket six months later when somebody's bookmarks break.

The pattern is anchored and forbids leading or trailing hyphens, because the
slug has to be a valid DNS label — it becomes a subdomain the moment
`TENANT_RESOLVER_SUBDOMAIN` is switched on. A reserved list keeps `api`, `www`,
`admin` and `platform` out of tenant hands.

---

## 5. Branch codes are tenant-local

`(company_id, code) WHERE deleted_at IS NULL` — a partial unique index.

Deliberately not global. Half the salons in the country want `HQ` or `MAIN`, and
making the first one to sign up the owner of that string would be absurd. A test
creates `HQ` in two companies and expects both to succeed.

Codes are uppercased on the way in, so `hq` and `HQ` cannot coexist and confuse
a receptionist reading a printed schedule. The filter on `deleted_at` also means
deleting a branch releases its code: a company that closes `HQ` and opens a new
one can call it `HQ`.

---

## 6. Timezone and currency

**Timezone is required on every branch**, with no fallback to the company
default. A branch in another city may be in another timezone, and the BRANCH
timezone is what bookings are calculated against — defaulting it silently would
make the one field that decides when a salon opens the easiest one to get wrong.
The UI should prefill the company's value and let a human confirm it.

Both timezone and currency are validated against the `timezone` and `currency`
reference tables **before** the foreign key sees them, so an unknown value is a
400 naming the field rather than an opaque 500.

**No float ever touches money or coordinates.** Percentages are basis points
(10000 = 100%) as integers. Latitude and longitude travel as *strings* and are
converted to `Prisma.Decimal` in the service — accepting a JS number would
round-trip six decimal places of longitude through a float, which is the one
thing a `Decimal(9,6)` column exists to prevent. They come back as strings too.

---

## 7. Business hours

`PUT`, not `PATCH`. Opening hours are read as a set — "Tuesday to Saturday" is
one decision — and applying it as seven independent edits would leave windows
where the schedule is half old and half new, which a future availability engine
would happily materialise.

**Days you omit become CLOSED.** Silence about Sunday means closed on Sunday;
carrying the previous value forward would make the result depend on history
nobody can see.

**Overnight hours are valid.** `22:00 → 06:00` is accepted, not rejected:
`business_hours.crosses_midnight` is maintained by a database trigger precisely
so the availability materializer never has to guess. Refusing `closesAt <
opensAt` would break every late-night venue and contradict the schema. The one
case refused is `opensAt === closesAt`, which describes a zero-length day rather
than a full one.

`crossesMidnight` is derived by the database and is read-only on the wire — a
client never sends it, so the flag cannot disagree with the times.

Hours are versioned by `effectiveFrom` (default today), so summer hours can be
set in advance. A read returns the version in force.

---

## 8. Lifecycle: deactivate, never delete

`DELETE /companies/:id` sets `status: CANCELED` and a 90-day `purgeAfter`.
Nothing is removed. A company owns appointments, payments, invoices, ledger
entries and an audit trail; cascading through financial history has no undo, and
in the ledger's case it is legally required to survive.

`deletedAt` is deliberately **not** set. Every company-owned table's RLS policy
matches on `company_id` alone, so soft-deleting the parent would not hide the
children — it would only make the company invisible to its own administrators
while its data stayed queryable, which is the worst of both.

**Deactivation is one-way, and that is structural rather than policy.**
`MembershipService` treats a `CANCELED` company as not found, so the moment a
company cancels, every member is locked out — including the owner who would have
to ask for it back. Offering "reactivate" on a tenant-scoped route would
advertise a state no caller can ever be in. Reactivation is therefore a platform
operation, and **it is not built yet**.

`SUSPENDED` is not reachable from these endpoints in either direction. It is a
platform decision, usually non-payment, and a company able to set or clear it
would make it meaningless. A suspended company is also operationally read-only,
so `@RequiresWrite()` refuses its mutations before any service runs.

Branch deletion is a soft delete for the same reason: a branch is referenced by
appointments, payments and gift cards, and the bookings that happened there must
keep resolving.

---

## 9. Permissions, not role names

Nothing in these controllers asks whether the caller is an `OWNER` or a
`BRANCH_MANAGER`. Which roles carry which permission is a company's own
configuration, and a controller that named a role would quietly ignore it.

Tests assert the shape rather than the labels: a `READ_ONLY` member reads and
cannot write; a `BRANCH_MANAGER` manages branches but cannot edit the company;
an `EMPLOYEE` is refused company administration entirely; a platform operator
who has not targeted a company gets 404 rather than a company-level pass.

**Branch-level access** (`company_user_branch`, surfaced on the request context
as `membership.branchScope`) exists in the schema and is **not enforced yet**,
because nothing consumes it. Every branch read goes through one repository, so
applying it later is one filter in one place rather than a sweep through
controllers.

---

## 10. Audit

| Action | Resource |
|---|---|
| `company.updated` | `company` |
| `company.deactivated` | `company` |
| `company.settings_updated` | `company_settings` |
| `company.branding_updated` | `company_branding` |
| `branch.created` · `branch.updated` · `branch.deactivated` | `branch` |
| `branch.settings_updated` | `branch_settings` |
| `branch.business_hours_updated` | `business_hours` |

All company-level rows, so they land in that company's own trail. Diffs record
only the fields worth reviewing — no timestamps, no ids, no credentials.

> **A bug this module found.** `AuditService` takes an advisory lock with
> `SELECT pg_advisory_xact_lock(...)`, which returns `void` — and Prisma 5's
> `$queryRaw` throws "Failed to deserialize column of type 'void'". Because the
> service swallows its own failures by design (an audit write must not roll back
> the business action that succeeded), this surfaced only as an ERROR log line,
> and **every hash-chained company audit row was being silently dropped**. Fixed
> by using `$executeRaw`, which takes the same lock and returns a row count.
> The first test to assert an audit row exists is what caught it.

---

## 11. Frontend foundation

Services and hooks only — no dashboard yet.

```
services/company.service.ts     profile, settings, branding
services/branches.service.ts    CRUD, settings, business hours
features/companies/             useCompany, useCompanySettings, useCompanyBranding + mutations
features/branches/              useBranches, useBranch, useCreateBranch … + useSelectedBranch
```

The company id always comes from the **session**, never from a prop or the URL.
That is a UX decision rather than a security one — the server validates it
regardless — but taking it from one place means a screen cannot render company
A's name over company B's data.

Query keys are namespaced by company id. Switching company already clears the
cache; the id in the key means that if a clear were ever missed, the worst case
is a cache miss rather than one tenant's data under another's name.

`useSelectedBranch` remembers a choice in `localStorage`, keyed by company. A
branch id is not a credential — the rule this codebase follows is that
long-lived credentials never touch script-readable storage, while a per-viewer
convenience is exactly what it is for. The selection is **derived during
render** from three ordered candidates rather than mirrored into state by an
effect, and reads go through `useSyncExternalStore` so SSR sees `null` and
hydration cannot mismatch.

---

## 12. Not built yet

- **Company creation from inside the app.** Provisioning is operator-only.
- **Reactivating a cancelled company** — needs a platform endpoint (§8).
- **Purging** a cancelled company's data after `purgeAfter`.
- **Logo and favicon upload** — needs the file module.
- **Branch-level access enforcement** (§9).
- **Custom domains.** `company_domain` exists and the two host-based tenant
  resolvers are written and switched off, because DNS verification and
  on-demand TLS do not exist.
- **Anything that consumes these settings.** The scheduling engine that reads
  booking policy and opening hours is the next milestone but one.
