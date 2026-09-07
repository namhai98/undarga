# Company Provisioning

How a company comes into existence.

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) and [MULTI-TENANCY.md](./MULTI-TENANCY.md).
This describes what was **built**, not what was planned.

---

## 1. Why an operator does this and not a signup form

There is no self-serve signup. Creating a company means creating its billing
relationship, and plans, trials and entitlements are still open design decisions
([ARCHITECTURE.md §16](./ARCHITECTURE.md) #16 and #17). Operator provisioning
sidesteps all of it: the commercial terms are agreed out of band, and the
platform records the result.

Self-serve can be added later as a second entry point into the same service —
nothing in `CompanyProvisioningService` assumes who called it.

---

## 2. Endpoints

Both live on `PlatformCompaniesController` and carry `@PlatformOnly(...)`, which
declares the platform token audience *and* the required permission. A staff
token is rejected at the audience check, before any permission is consulted.

| Method | Path | Permission |
|---|---|---|
| `POST` | `/api/v1/platform/companies` | `platform:company:provision` |
| `GET` | `/api/v1/platform/companies/:id` | `platform:company:list` |

The route parameter is `:id`, **not** `:companyId`, because
`RouteParamTenantResolver` keys on `params['companyId']`. These routes are
platform-only so the resolver never runs today; the naming keeps them inert even
if someone later adds `@AllowPlatformAccess()`.

### Authentication

`Authorization: Bearer <platform access token>`, obtained from
`POST /api/v1/platform/auth/login`. Platform and staff tokens carry different
audiences and are not interchangeable in either direction.

---

## 3. `POST /api/v1/platform/companies`

### Request

| Field | Type | Required | Notes |
|---|---|---|---|
| `slug` | string | ✅ | 3–64 chars, `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, not reserved |
| `legalName` | string | ✅ | 1–160 |
| `displayName` | string | ✅ | 1–160. **Not unique** — see §6 |
| `defaultTimezoneName` | string | ✅ | Must exist in `timezone` |
| `currencyCode` | string | ✅ | Uppercase ISO 4217, must exist in `currency` |
| `locale` | string | | Defaults to `en-US` |
| `registrationNumber` | string | | ≤ 64 |
| `taxNumber` | string | | ≤ 64 |
| `contactEmail` | string | | Valid email |
| `contactPhone` | string | | ≤ 32 |
| `owner.email` | string | ✅ | Valid email |
| `owner.fullName` | string | ✅ | 1–128 |

**The slug is a DNS label.** It becomes a subdomain the moment
`TENANT_RESOLVER_SUBDOMAIN` is switched on, which is why leading and trailing
hyphens are refused and why a reserved list exists: a tenant holding `api`,
`www` or `admin` would sit on a hostname the platform itself needs, and
`platform` would let a tenant page impersonate the operator console. The slug is
also cached by `TenantDirectoryService` and is effectively immutable afterwards
— cheap to refuse up front, expensive to take back.

### What one call creates

In a single transaction on the platform connection:

1. `company` — status **`PENDING_SETUP`**, not `ACTIVE`
2. `company_settings` — every booking-policy value from its schema default
3. six `company_role` rows from `SYSTEM_ROLES`, each `isSystem: true`
4. their `company_role_permission` rows from `SYSTEM_ROLE_PERMISSIONS`
5. the owner's `user_account` — found by email, or created
6. the owner's `company_user` — `isOwner: true`
7. `company_user_role` linking that membership to `OWNER`

Then, **after the commit**, `TenantDirectoryService.invalidate(id, slug)`.

### Success — `201 Created`

```json
{
  "data": {
    "company": {
      "id": "01a06c4d-e63d-7962-a180-ef2a2825b1f3",
      "slug": "glow-studio",
      "legalName": "Glow Studio LLC",
      "displayName": "Glow Studio",
      "status": "PENDING_SETUP",
      "defaultTimezoneName": "Asia/Ulaanbaatar",
      "currencyCode": "MNT",
      "locale": "en-US",
      "createdAt": "2026-09-04T12:03:59.677Z"
    },
    "owner": {
      "userAccountId": "01a06c4d-e663-7bf2-afa2-00080bb1adc1",
      "companyUserId": "01a06c4d-e664-7d93-addf-4bbd96977148",
      "email": "nara@glow.mn",
      "fullName": "Nara B",
      "status": "INVITED",
      "accountCreated": true,
      "requiresInvitation": true
    },
    "roles": [
      { "id": "…", "key": "OWNER", "name": "Owner", "isSystem": true },
      { "id": "…", "key": "ADMIN", "name": "Administrator", "isSystem": true },
      { "id": "…", "key": "BRANCH_MANAGER", "name": "Branch manager", "isSystem": true },
      { "id": "…", "key": "RECEPTIONIST", "name": "Receptionist", "isSystem": true },
      { "id": "…", "key": "EMPLOYEE", "name": "Employee", "isSystem": true },
      { "id": "…", "key": "READ_ONLY", "name": "Read only", "isSystem": true }
    ]
  },
  "meta": { "requestId": "3bb42b5b-9905-489b-b339-95a7df813e86" }
}
```

**`owner.requiresInvitation` is the field the onboarding UI branches on.** It
says whether the owner can sign in yet:

| Owner email | Membership | `requiresInvitation` |
|---|---|---|
| New address | `INVITED` | `true` — needs an invitation link |
| Existing `ACTIVE` account | `ACTIVE` | `false` — can sign in now |

The account is reused rather than duplicated because one person running three
salons is an ordinary case, and a second account for the same address would
split their identity permanently. Membership status mirrors whether they can
*actually* authenticate — marking everyone `ACTIVE` would report a company as
staffed by someone who cannot log in.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Bad shape; reserved or malformed slug; unknown timezone or currency |
| 401 | `UNAUTHENTICATED` | No token |
| 401 | `TOKEN_AUDIENCE_MISMATCH` | A **staff** token |
| 403 | `PERMISSION_DENIED` | A platform operator without `platform:company:provision` |
| 404 | `PLATFORM_ACCESS_REQUIRED` | Authenticated, but not a platform operator |
| 409 | `CONFLICT` | Slug taken (`details.field: "slug"`), or the owner address belongs to a deleted or disabled account (`details.field: "owner.email"`) |

Unknown timezone and currency are checked in the service rather than left to the
foreign key. Both would otherwise surface as an opaque 500; checking turns them
into a 400 naming the field, which is the difference between a caller fixing
their request and filing a bug.

---

## 4. `GET /api/v1/platform/companies/:id`

Reads a provisioned company back, so the onboarding flow does not have to hold
the provisioning response and an operator can confirm state afterwards.

```json
{
  "data": {
    "id": "01a06c4d-e63d-7962-a180-ef2a2825b1f3",
    "slug": "glow-studio",
    "status": "PENDING_SETUP",
    "contactEmail": "hello@glow.mn",
    "suspendedAt": null,
    "_count": { "users": 1, "roles": 6, "branches": 0 }
  },
  "meta": { "requestId": "…" }
}
```

The counts let a caller judge setup progress without a second request.
`404 RESOURCE_NOT_FOUND` for an unknown or soft-deleted company.

---

## 5. Atomicity

Every write is in one `$transaction`. A company with no roles cannot grant
anyone anything, and a company with no owner is unadministrable — with no
self-serve signup there is no way back without another operator call. Both are
worse than no company at all.

There is no compensating-cleanup path, because there is nothing to compensate
for: a failure at any step leaves the database exactly as it was. Two tests
assert it directly, including that a rolled-back attempt **leaves the slug
free** — a partial rollback would reserve the slug at the unique index forever
and the customer could never be onboarded.

The slug pre-check is a check-then-act and is deliberately not the only defence.
Two concurrent provisions of the same slug both pass it and one loses at the
unique index; `P2002` is mapped to the same 409, so the race is
indistinguishable from the ordinary case. **The check exists for the message,
the constraint exists for the correctness.**

Cache invalidation is *outside* the transaction and after the commit.
`findCompanyIdBySlug` caches misses as well as hits, so a slug probed before
provisioning would otherwise stay unresolvable for `TENANT_CACHE_TTL_SECONDS`.

---

## 6. Two things deliberately not validated

**Duplicate display names are allowed.** Trading names are not unique within one
country, let alone across a SaaS. Enforcing uniqueness would reject legitimate
customers to solve a problem nobody has; the slug is the identifier.

**Email addresses are not verified.** Provisioning records the owner an operator
was told about. Proof of control over the address comes from accepting the
invitation, and real verification arrives with email in phase 6.

---

## 7. Audit

One row per provision: `platform.company.provisioned`, written with
`platformLevel: true` so `company_id` is NULL. This is an action *on* a company
rather than within one, and the operator who performed it is not a member — a
tenant-scoped row would be invisible to the very people who need it.

Payload records the slug, display name, owner email and whether the account was
created. It never records credentials.

---

## 8. Trying it

```bash
pnpm db:seed:demo    # creates provisioning@platform.test
```

```bash
curl -s -X POST http://localhost:3000/api/v1/platform/auth/login -H 'Content-Type: application/json' -d '{"email":"provisioning@platform.test","password":"correct-horse-battery-staple"}'
```

Then, with the returned `accessToken`:

```bash
curl -s -X POST http://localhost:3000/api/v1/platform/companies -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"slug":"glow-studio","legalName":"Glow Studio LLC","displayName":"Glow Studio","defaultTimezoneName":"Asia/Ulaanbaatar","currencyCode":"MNT","owner":{"email":"nara@glow.mn","fullName":"Nara B"}}'
```

Interactive equivalents are in Swagger at `/api/docs` under the **platform** tag.

---

## 9. Not built yet

- **Company listing, suspend and unsuspend.** `platform:company:list` and
  `:suspend` exist in the catalog; only the single read is implemented.
  Suspension in particular must invalidate both `TenantDirectoryService` and
  `MembershipService`, or a suspended tenant keeps working for up to
  `TENANT_CACHE_TTL_SECONDS`.
- ~~**The invitation the owner needs.**~~ **Built** — see
  [INVITATIONS.md](./INVITATIONS.md). Accepting an invitation that carries the
  owner's pre-created membership activates that row rather than creating a
  second one.
- **Any operator console UI.** Platform login has no second factor — see the
  note in `AuthService.loginPlatform` — so provisioning is deliberately
  API-only for now.
