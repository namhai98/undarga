# Platform Admin

The operator console: the one module that is supposed to read across tenants.

This describes what was **built**, not what was planned.

---

## 1. Endpoints

All under `/api/v1/platform`, all `@PlatformOnly`.

| Method | Path | Permission |
|---|---|---|
| `GET` | `/platform/dashboard` | `platform:company:list` |
| `GET` | `/platform/companies` | `platform:company:list` |
| `POST` | `/platform/companies` | `platform:company:provision` *(pre-existing)* |
| `GET` | `/platform/companies/:id` | `platform:company:list` |
| `PATCH` | `/platform/companies/:id/status` | `platform:company:suspend` |
| `GET` | `/platform/companies/:id/users` | `platform:company:list` |
| `GET` | `/platform/companies/:id/subscription` | `platform:company:list` |
| `GET` | `/platform/audit-logs` | `platform:audit:read` |

**No new permission keys.** All four already existed in
`packages/shared/src/permissions.ts`.

---

## 2. Platform access is not company RBAC wearing a hat

Three independent things have to be true, and each fails separately:

| Layer | What it checks | Failure |
|---|---|---|
| `JwtAuthGuard` | The token's **audience** is the platform realm | `401 TOKEN_AUDIENCE_MISMATCH` |
| `TenantGuard` | `@PlatformOnly` short-circuits it; no company is resolved | — |
| `PermissionGuard` | The operator's own `platform_role` grants | `403` |

The headline property, and the first test in the suite: **a company owner
holding the entire company permission catalogue is rejected with a 401, not a
403.** The token is the wrong kind. There is no company permission that opens a
platform route, and there is no ladder from one to the other.

Platform permissions are also not one undifferentiated "is an operator" flag.
Three separate tests prove it:

- `platform:billing:manage` alone → 403 on every console route.
- `platform:company:list` without `platform:audit:read` → can list tenants,
  cannot read the audit trail. Reading the history of everything every tenant
  has ever done is a larger grant than listing them.
- `platform:company:list` without `platform:company:suspend` → can read a
  company, cannot take it offline.

And it does not leak the other way: a console token still **cannot** use a
company route, because `MembershipService` requires
`platform:company:data:read` explicitly and the console permissions do not
include it.

---

## 3. "DISABLED" is this schema's `CANCELED`

`company_status` is `PENDING_SETUP | ACTIVE | SUSPENDED | CANCELED` and has been
since the first migration. The brief's three states map onto it:

| Brief | Schema |
|---|---|
| ACTIVE | `ACTIVE` |
| SUSPENDED | `SUSPENDED` |
| DISABLED | `CANCELED` |
| — | `PENDING_SETUP` — provisioned, owner has not accepted their invitation |

The enum is **not** renamed. `MembershipService`, `operationalStatus`, the seeds
and the isolation suite all key on the existing value, and a rename buys nothing
but churn and a migration.

`PENDING_SETUP` is surfaced rather than hidden: a company exists from the moment
it is provisioned, and a console that omitted that state would show a shorter
list than the database has.

The UI labels `CANCELED` as **"Disabled"**, which is what it means to the person
reading the screen. The API vocabulary is never relabelled — a filter sends
`CANCELED`, the audit action is `platform.company.canceled` — so there is one
vocabulary on the wire and a label on top of it.

> Unrelated but worth knowing: `SubscriptionStatus` spells it **CANCELLED** with
> two Ls while `CompanyStatus` spells it **CANCELED** with one. Both are
> pre-existing; each is matched exactly.

---

## 4. Status changes

`PATCH /platform/companies/:id/status` with a `status` and a **mandatory
reason**.

### Why the reason is mandatory

Suspending a company stops every member of its staff working and every customer
booking. Six months later somebody asks why, and "an operator clicked it" is not
an answer. The reason goes onto the hash-chained audit trail, filed **against
the company it happened to** — so the tenant can see it on their own audit
screen rather than it vanishing into a platform-level row.

### Legal transitions

| From | To |
|---|---|
| `PENDING_SETUP` | ACTIVE · SUSPENDED · CANCELED |
| `ACTIVE` | SUSPENDED · CANCELED |
| `SUSPENDED` | ACTIVE · CANCELED |
| `CANCELED` | **ACTIVE** |

`PENDING_SETUP` is not a target: it is a fact about history, not a state anybody
can put a company back into. A no-op is a `409`.

### `CANCELED → ACTIVE` is why this endpoint exists

The company-facing `POST /companies/:id/deactivate` is deliberately **one way**:
`MembershipService` treats a CANCELED company as not-found, so the owner who
cancelled can no longer reach anything — including a reactivate button. An
operator is exactly who should be able to undo it, and this is the only path
back.

### Cache invalidation is part of the security model

`TenantDirectoryService` caches company status for `TENANT_CACHE_TTL_SECONDS`.
Without the invalidation after the write, a suspended tenant keeps working for
the rest of that window, silently, with no error anywhere. One line; the whole
difference between *suspended* and *suspended soon*.

An end-to-end test proves it: suspend, then a company owner's request to their
own tenant fails; reactivate, and it works **immediately** rather than after a
TTL.

---

## 5. What the console does not show

Operators run a SaaS business. They need to know a tenant exists, whether it is
paying, how big it is and whether it is healthy. They do **not** need the names,
phone numbers, emails, notes or appointment history of that tenant's customers —
a console that showed them would turn one compromised operator account into a
breach of every tenant at once.

So:

- **Every customer-shaped thing is a COUNT.** `counts.customers` is a number;
  there is no endpoint that lists them.
- **Company users are returned** — the people who bought the product, which is
  who an operator supports. Even there: no password hash, session, MFA secret or
  token is selected.
- **Audit `before`/`after` payloads are not returned.** For a tenant's own
  actions they contain customer names and prices. An operator sees *that*
  something changed and who did it. Only `metadata.reason` on `platform.*`
  actions is surfaced, guarded on the action prefix so a feature module that
  happens to put a `reason` in its metadata never has it republished.

Three tests assert this directly, by reading a seeded customer's real name,
email and phone out of the database and checking they appear nowhere in the
company detail, the dashboard, or any audit row.

---

## 6. The console has its own session

| | Staff app | Platform console |
|---|---|---|
| Token store | `tokenStore` | `platformTokenStore` |
| API client | `apiClient` | `platformApiClient` |
| Refresh | `POST /auth/refresh` + HttpOnly cookie | **none** |
| Company header | `X-Company-Id` | never sent |
| Survives reload | yes | **no** |

**Why two stores.** `token-store.ts` is a module-level singleton. If the console
wrote to it, signing into the platform would sign you out of the staff app in
the same tab — and an operator who is also a member of a company, common in a
small business, would find the two logging each other out all day. Two stores
also means the staff client is *structurally incapable* of putting a platform
token on a company request, and vice versa. Twelve unit tests pin this.

**Why no refresh.** The API exposes `POST /platform/auth/login` and
`/logout` and nothing else. No refresh route exists, and the refresh cookie is
scoped to `/api/v1/auth` — the staff path — so a platform session could not be
revived from one even in principle. The console's login screen says so rather
than leaving it to be discovered.

The login form gives **one message for every rejection**. Distinguishing "no
such operator" from "wrong password" tells an attacker which half they got
right, and an operator account is a key to every tenant on the platform.

---

## 7. Efficiency

Every figure on the dashboard is a `groupBy` or a `count`; nothing loads rows to
reduce them in JavaScript. Companies-by-status and subscriptions-by-status are
one grouped query each rather than four counts apiece.

The whole dashboard is **one request**, so every number is from the same
instant — a dashboard assembled from eight calls shows eight slightly different
moments, and the first person to notice is whoever adds up the statuses and
finds they do not match the total.

The company list filters on indexed columns and the detail page issues seven
counts in parallel.

---

## 8. Files

**Backend**

    apps/api/src/platform/dto/platform-admin.dto.ts          new
    apps/api/src/platform/platform-admin.service.ts          new
    apps/api/src/platform/platform-admin.controller.ts       new
    apps/api/src/platform/companies/platform-companies.controller.ts   extended
    apps/api/src/platform/platform.module.ts                 wired
    apps/api/test/support/seed.ts                            + a platformAdmin operator
    apps/api/test/platform-admin.e2e-spec.ts                 new

**Frontend**

    apps/web/services/platform-api-client.ts                 new
    apps/web/services/platform.service.ts                    new
    apps/web/services/platform-api-client.test.ts            new
    apps/web/features/platform/{api,ui}/                     new
    apps/web/app/(platform)/platform/                        new route group

**No database changes.** No migration, no new model, no new enum value, no new
permission key.

---

## 9. Tests

`apps/api/test/platform-admin.e2e-spec.ts` — **50 tests**.

| Block | Covers |
|---|---|
| the realm boundary | anonymous, a company OWNER on every route including their own company, a staff token on the status change leaving the database unchanged |
| platform permissions are not one flag | billing-only operator refused everywhere; audit separate from list; suspend separate from read |
| company list | cross-tenant listing, counts-not-contents, search, status filter, pagination, strict query |
| company detail | the seven counts, **no customer data anywhere in the payload**, activity shape without payloads, 404 |
| status management | suspend with an audited reason, reactivate clearing `suspendedAt`, **CANCELED → ACTIVE**, mandatory reason, PENDING_SETUP refused, no-op 409, and a suspended company being unreachable by its own staff **immediately** |
| company users | roles, no credentials, only this company's members, filters, 404 |
| subscription and usage | no subscription without inventing one, plan limits against counters, a negotiated override beating the plan, list filter by subscription |
| dashboard | status counts including DISABLED, moving when a company is suspended, users/appointments/subscriptions, no tenant data |
| audit logs | spanning tenants, the operator's reason, a tenant's own `reason` key not leaking, filters, pagination |
| tenant isolation is untouched | a console token still cannot use a company route; A still cannot see B |

Front end:

- `platform-api-client.test.ts`: 12 tests on session separation.
- `features/platform/ui/platform.test.tsx`: 20 tests.
  - Sign-in gate: no console without a platform session, a staff session does not unlock it, one message for every rejected login, and an unreachable API is not reported as bad credentials.
  - Requests carry only the platform token, with no company header.
  - Dashboard: all eight figures, plus an error state.
  - Company list: search, status filter (Disabled = `CANCELED`), empty state, pagination.
  - Company detail: counts, subscription, usage, activity, a reason plus confirmation before any status change, cancel, reactivate-only for a disabled company, API error shown.
  - Company users: roles, owner badge, filters, empty and error states.

## Console pages

| Path | Shows |
|---|---|
| `/platform` | Dashboard |
| `/platform/companies` | Search and filter companies, paged |
| `/platform/companies/:id` | Info, counts, subscription and usage, status change, recent activity, first 5 users |
| `/platform/companies/:id/users` | All company users: search, membership filter, paged |
| `/platform/audit-logs` | Cross-tenant audit trail |

---

## 10. Limitations

- **A page reload signs an operator out.** No platform refresh endpoint exists.
  Adding one means a second cookie path and a platform session-rotation story;
  it was not in scope.
- **Platform login has no MFA enforcement.** `auth.service.ts` logs an error
  when an operator signs in without enrolment and lets them through. That
  pre-dates this module and the console does not change it — but a UI makes the
  gap reachable by a browser, which it was not before. Worth closing before this
  console is exposed outside a trusted network.
- **No impersonation.** Explicitly out of scope, and nothing here approaches it.
- **Creating a company is the existing provisioning endpoint.** It needs
  `platform:company:provision`, which the console's `platformAdmin` role does
  not hold, so there is no "new company" button in the UI — the API is there and
  a differently-permissioned operator can call it.
- **No operator management.** `platform:operator:manage` exists and nothing uses
  it; operators are seeded or created by hand.
- **No subscription mutation.** The console reads plans and usage; changing a
  plan belongs to the subscriptions module.
- **Audit `before`/`after` is never exposed**, by design. An operator
  investigating a specific data change has to ask the tenant.
