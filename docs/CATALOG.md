# Service and Category Management

What a company sells, and how it is grouped.

Companion to [EMPLOYEES.md](./EMPLOYEES.md). This describes what was **built**,
not what was planned.

---

## 1. Endpoints

All nested under `/companies/:companyId`, all `service:read` or `service:write`.

| Method | Path |
|---|---|
| `GET` `POST` | `/service-categories` |
| `GET` `PATCH` `DELETE` | `/service-categories/:categoryId` |
| `GET` `POST` | `/services` |
| `GET` `PATCH` `DELETE` | `/services/:serviceId` |
| `GET` `POST` | `/services/:serviceId/branches` |
| `DELETE` | `/services/:serviceId/branches/:branchId` |
| `GET` `POST` | `/services/:serviceId/employees` |
| `DELETE` | `/services/:serviceId/employees/:employeeId` |

---

## 2. Why `service:read` / `service:write` and no category permissions

The catalog is one thing to administer: nobody manages categories without
managing the services in them.

Inventing `service.category.create` would mean the six seeded system roles
silently lack it, so every company already provisioned would have to reconfigure
its roles before anyone could add a category — a migration imposed on customers
to express a distinction they do not make.

The permission table stays at 59 keys.

---

## 3. Bookable is not public

Two columns, two different questions:

| Column | Question |
|---|---|
| `status` | Can it be booked **at all**? |
| `isOnlineBookable` | Is it shown on the **public booking site**? |

An internal-only service — staff training, a supplier visit, a comped
touch-up — is `status: ACTIVE` with `isOnlineBookable: false`: reception can
book it, the public cannot see it. A `DRAFT` service is nowhere.

There is deliberately **no third `isPublic` flag**. Three booleans over the same
idea produce states nobody can describe (`isPublic: true`, `isOnlineBookable:
false` — what is that?) and every consumer would have to guess a precedence
order.

A soft delete sets `status: ARCHIVED` **and** clears `isOnlineBookable`. Belt
and braces: a public booking page that forgets to filter on `deletedAt` still
cannot offer the service.

---

## 4. Categories nest exactly two levels

The schema models a tree — `service_category.parent_id` is a self-relation — and
the unique index is `(company_id, parent_id, name) WHERE deleted_at IS NULL`.
That composite is the point of the hierarchy: `Hair > Colouring` and
`Nails > Colouring` can both exist, which a flat unique-per-company index would
make impossible.

Depth is capped at **two** in the service layer, which the database cannot
express. A booking page shows a list of groups with services under them; a third
level would either be flattened by every consumer or render as something nobody
designed. Capping it in one place is cheaper than discovering it in four UIs.

Three moves are refused, each for a reason the foreign key would happily allow:

| Move | Result |
|---|---|
| Category as its own parent | `400` — a category that is its own ancestor makes every recursive read non-terminating |
| Nesting under a category that is already nested | `400` — that is depth three |
| Nesting a category that **has** children | `400` — also depth three, by the back door |

### Deleting is refused, not cascaded

A category holding live services or live sub-categories cannot be deleted.
Cascading would orphan a price list — and because `service.category_id` is
**nullable**, the failure would not even surface as a foreign-key error, just a
catalogue that quietly lost its structure.

The `409` carries a count:

```json
{ "error": { "code": "CONFLICT", "details": { "serviceCount": 12 } } }
```

which is what lets the UI say *"move these 12 services first"* rather than
*"cannot delete"*.

---

## 5. `code`, not `slug`

The brief asked for a slug. The schema has `service.code` — `VarChar(24)`,
unique per company where not deleted — and no slug column.

`code` is the right thing anyway: it is the operator's own reference (`CUT-60`,
`MSG-90`), it appears on a receipt, and it is what someone types into a search
box. A slug is a URL segment, and public booking URLs are not built yet. Adding
a second identifier column now would mean two things to keep unique and two
things to keep in step.

Codes are uppercased and trimmed on the way in, matching branch and employee
codes.

---

## 6. Money

`price_minor` and `deposit_minor` are `BigInt` columns, and they travel as
**strings**:

```json
{ "priceMinor": "5000000", "currencyCode": "MNT" }
```

A JS number holds integers exactly only to 2^53, and minor units reach that
sooner than it looks. Nothing in the API or the web app parses a price into a
float. The web app formats through `formatMoney` and reads a typed amount back
through `decimalToMinorString`, both in `@undarga/shared` — the two live in one
file precisely so they cannot disagree about where the decimal point goes.

`currencyCode` defaults to the company's. It is overridable because the schema
allows it and a cross-border company is real, but almost nobody should set it: a
service priced in a currency the company does not settle in is a reporting
problem waiting to happen.

A deposit flag with no amount, or an amount with no flag, is rejected — checked
against the **merged** state on `PATCH`, so turning the flag on alone is caught
even though the request body looks fine on its own.

---

## 7. Time

Three whole-minute columns:

```
bufferBeforeMin  +  durationMin  +  bufferAfterMin  =  totalOccupiedMin
```

`durationMin` is what the customer is sold. `totalOccupiedMin` — computed on
every response — is what the availability engine will reserve on a calendar.
Setup and clean-up are real time that cannot be double-booked, and folding them
into the duration would either overcharge the customer or lie about the slot.

Bounds: duration 1–1440 (a single service cannot run longer than a day), each
buffer 0–480.

---

## 8. `/services/:id/employees` is the same table as `/employees/:id/services`

Both write `employee_service`, primary key `(company_id, employee_id,
service_id)`.

There is **no second junction table**. Two would drift the moment one screen
wrote to one and another screen read the other, and the availability engine
would have to pick a winner. Assigning from either direction produces the
identical row; a `409 ALREADY_ASSIGNED` from either direction means the same
row already exists. An e2e test asserts exactly this, in both directions and by
row count.

The web app's catalog hooks invalidate `employeeKeys` as well as `catalogKeys`
for the same reason.

Being assigned to a service does **not** mean the person can provide it at every
branch. The availability engine will intersect employee↔branch with
service↔branch; these endpoints record the two halves and nothing more.

### Branch assignment carries overrides

`service_branch` holds `isAvailable`, `priceOverrideMinor` and
`durationOverrideMin` — one branch charges differently, or a room being refitted
means the service is assigned but temporarily withheld. Keeping the assignment
and flipping `isAvailable` preserves the overrides that would be lost by
removing and re-adding it.

---

## 9. Resource requirements

`service_resource_requirement` records what a service needs **by type** — "a
treatment room", not "room 3" — with a quantity.

Encoding a specific resource would make every booking of that service fail
whenever that one room is busy. Which actual room is used is the availability
engine's decision at booking time.

Supplying `resourceRequirements` on `PATCH` replaces the whole set. Requirements
are read as a set, and patching them one at a time would leave a service
half-configured between two calls.

Nothing creates `resource_type` rows through an API yet — Resource Management is
a separate module. The relationship is built now so it does not have to be
retrofitted into a working catalogue.

---

## 10. Tenant isolation

Everything goes through `TenantScopedRepository`, so every query carries
`companyId` and RLS is set on the connection. Cross-tenant access returns
**404, never 403** — a 403 confirms the row exists.

Every foreign id in a request is validated against the caller's company
**before** anything is written:

| Attempt | Result |
|---|---|
| Read / update / delete another company's service | `404` |
| Put a service in another company's category | `404`, nothing created |
| Offer a service at another company's branch | `404`, no join row |
| Assign another company's employee | `404`, no join row |
| Nest a category under another company's category | `404` |

The last four matter more than the first: composite foreign keys
`(company_id, id)` would refuse the write anyway, but as a `500` nobody planned
rather than a refusal with a shape. Validating first also means a create naming
one foreign branch leaves **nothing** behind.

The same code is legal in two different companies. The unique index is
`(company_id, code) WHERE deleted_at IS NULL AND code IS NOT NULL`.

---

## 11. Soft delete

`DELETE` sets `deleted_at`, `status: ARCHIVED` and `isOnlineBookable: false`.
The row stays: appointments, promotions and waitlist entries reference it, and
history that cannot resolve a service name is history nobody can read.

Every list and lookup filters `deleted_at IS NULL`, so a deleted service is a
`404` to the API and absent from the UI.

---

## 12. Tests

`apps/api/test/catalog.e2e-spec.ts` — 53 tests against the real application.

| Block | Covers |
|---|---|
| categories | create, nest, same name under different parents, duplicate, three-level refusal, cycles, delete with counts |
| service CRUD | create with relationships, update, soft delete, bookable ≠ public, code uniqueness |
| validation | duration, buffers, price format, currency, deposit cross-check, unknown fields, `companyId` refused |
| search, filter, pagination | search, category / branch / employee / bookable filters, paging, deleted excluded |
| assignments | branches with overrides, duplicates, **both doors onto `employee_service`**, one row not two |
| tenant isolation | the table in §10, each asserting the database is unchanged afterwards |
| permissions | anonymous, READ_ONLY, EMPLOYEE |
| audit | `service.created`, `service_category.created`, `service.branch_assigned` |

Front end: `apps/web/features/catalog/ui/service-list.test.tsx` and
`apps/web/lib/currency.test.ts` — the second is where the shared money
conversion is covered, including a value past 2^53 and a round trip.

---

## 13. Not built here

Availability, appointments, payments, promotions, gift cards and resource
management. A service's `requiresDeposit` is recorded and nothing charges it;
`requiresResource` is recorded and nothing allocates one. Those are the modules
that will read this data, not this module's job.
