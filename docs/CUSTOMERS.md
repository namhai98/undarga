# Customer Management

The people a company books work for.

Companion to [CATALOG.md](./CATALOG.md) and [EMPLOYEES.md](./EMPLOYEES.md). This
describes what was **built**, not what was planned.

---

## 1. Endpoints

All nested under `/companies/:companyId/customers`.

| Method | Path | Permission |
|---|---|---|
| `GET` `POST` | `/customers` | `customer:read` / `customer:write` |
| `GET` `PATCH` `DELETE` | `/customers/:customerId` | `customer:read` / `customer:write` |
| `GET` | `/customers/:customerId/appointments` | `appointment:read:any` |

`customer:note:read:private` and `customer:export` already exist in the
permission catalogue and are deliberately **not** used here: the first gates the
separate `company_customer_note` table, the second gates bulk download. Neither
feature is built, and borrowing either key now would silently change what it
means before the feature that needs it exists.

---

## 2. `company_customer` is the relationship, not the person

The schema separates two things that look like one, and everything else in this
module follows from it:

| Table | What it is |
|---|---|
| `customer_identity` | The **human**. Global, one row, they may eventually log in with it. |
| `company_customer` | What **one company** knows about them. Tenant-scoped. |

Every note, tag, statistic, consent, appointment and payment hangs off the
second. That is what stops Company A's record of a person reaching Company B,
and it is why the same phone number is legal in two companies and refused twice
within one.

This module only ever touches `company_customer`. Nothing here reads or writes
`customer_identity`: linking a booking account to a company record belongs to
the public-booking flow, and `customer_identity_id` stays NULL until somebody
proves control of the address there. A staff-created customer is a **record
about** a person, not an **account for** them.

---

## 3. Schema change

One column:

```sql
ALTER TABLE "company_customer" ADD COLUMN "address" VARCHAR(512);
```

Migration `20260909172339_customer_address`. Nullable with no default, so the
add is metadata-only and does not rewrite the table.

**Why one free-text line and not a structured address.** A branch has
`address_line1` / `city` / `postal_code` because it is geocoded and shown on a
map. A customer address is a note for whoever is driving there — a home-visit
hairdresser, a mobile valeter — and structuring it would impose one country's
postal shape on every tenant.

Nothing else was added. The brief's suggested fields already existed under
different names, and the existing ones are better:

| Suggested | What the schema already has |
|---|---|
| `name` | `first_name` + `last_name`. Kept split; the API composes `fullName` in the response so screens do not each join the halves. |
| `notes` | `notes VARCHAR(4000)`, plus a separate `company_customer_note` table for threaded, attributable, privately-flagged notes. Only the inline field is exposed here. |
| `status` | `customer_status` enum — `ACTIVE`, `BLOCKED`, `ARCHIVED`. |
| `createdAt` / `updatedAt` | Both present, plus `deleted_at` for the soft delete. |

---

## 4. Duplicates

Two partial unique indexes already existed in `001_hardening.sql`:

```sql
CREATE UNIQUE INDEX company_customer_email_uq ON company_customer (company_id, email)
  WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE UNIQUE INDEX company_customer_phone_uq ON company_customer (company_id, phone)
  WHERE deleted_at IS NULL AND phone IS NOT NULL;
```

The database is therefore the authority. The service checks first anyway, and
**both paths matter**: the pre-check loses a race between two concurrent
creates, and the `P2002` handler catches whatever the race let through. A
service-layer check alone would be a lie; the constraint alone would surface as
a constraint name.

The refusal is a `409` that names the field *and* the record holding it:

```json
{ "error": { "code": "CONFLICT",
             "details": { "field": "phone",
                          "existingCustomerId": "018f…",
                          "existingCustomerName": "Sara Ochir" } } }
```

The id is what lets the form offer **"open that customer"**. Telling somebody a
number is taken and then making them go and search for it is the version of
this that wastes a minute at a busy desk.

### Normalisation is part of the check, not cosmetics

Input is normalised before it is stored or compared:

- **Phone** — spaces, dashes, brackets, dots and slashes stripped. Without this
  `+976 9911 2233` and `+976-9911-2233` are two rows for one person, and the
  unique index means "the same keystrokes" rather than "the same human".
- **Email** — trimmed and lower-cased. The column is `citext` so the index would
  catch case anyway; normalising means the stored value is also what gets shown.

Phone is deliberately **not** validated as E.164. This product is sold where a
receptionist types `99112233`, and refusing that would make the field unusable
to protect a format nothing yet depends on.

The search box normalises the term the same way, so pasting `+976 9911 2233` out
of a message finds the customer saved as `+97699112233`.

### Merging is not built

A merge has to move appointments, payments, invoices, gift cards, loyalty
points and consent records, and decide which of two conflicting names wins.
Getting that wrong is worse than having two rows. Out of scope, as the brief
says.

---

## 5. Search and filters

All in SQL, against the existing indexes — including the trigram index on the
composed name that `001_hardening.sql` already creates.

| Parameter | Matches |
|---|---|
| `search` | first name, last name, email, and phone (normalised) |
| `status` | `ACTIVE` / `BLOCKED` / `ARCHIVED` |
| `tag` | array containment on `tags` |
| `preferredEmployeeId` | the usual staff member |
| `hasVisited` | `lastVisitAt` null or not — for cleaning up a list |
| `sortBy` / `sortOrder` | name, creation, last visit, visit count |
| `limit` / `offset` | max 100, default 25 |

The UI's search is one input on purpose: a receptionist has a name, a number or
an address in front of them and does not know which column it is. Splitting it
into three fields would only make somebody choose before they can type.

---

## 6. Read-only statistics

`loyalty_points`, `total_visits`, `total_no_shows`, `total_spent_minor`,
`first_visit_at` and `last_visit_at` are **projections** of the appointment and
payment tables, recomputed on their transitions.

The DTO is `.strict()` and does not include them, so a request that tries to set
one is a `400`. A client that could write them could make a customer's history
disagree with the ledger — and the ledger is the thing that gets audited.

`total_spent_minor` is `BigInt` and travels as a **string**. Nothing parses it
into a float.

---

## 7. Appointment integration

### The cross-company guarantee is in the schema, not in code

```prisma
customer CompanyCustomer @relation(
  fields: [companyId, customerId], references: [companyId, id])
```

A **composite** foreign key on `(company_id, customer_id)` referencing
`(company_id, id)`. An appointment in company A physically cannot point at a
customer in company B — there is no application check to bypass and no code path
that could forget one. A test asserts the constraint rather than trusting this
paragraph.

### History is read-only, and it is borrowed

`GET /customers/:id/appointments` reads the appointment table directly, because
**there is no appointments module yet**. When one lands, this method should
delegate to it (rule 5: a module does not query another module's tables) — which
is why the shape it returns is the summary an appointments module would expose
rather than the whole row.

No appointment business logic was added or changed.

### Why it needs `appointment:read:any`

Seeing a customer record is a different decision from seeing everything they
have ever booked. The `EMPLOYEE` system role holds `customer:read` and
`appointment:read:own` — a record-level narrowing this endpoint cannot express —
so the history is refused rather than silently widened. The detail page renders
an explanation in place of the table and does not fire the query at all, rather
than fire it and paint a red error panel.

---

## 8. Soft delete

`DELETE` sets `deleted_at` and `status: ARCHIVED`. The row stays: appointments,
payments and invoices reference it, and history that cannot resolve a customer
name is history nobody can read.

Both unique indexes are filtered on `deleted_at IS NULL`, so **deleting a
customer releases their phone and email**. That is what a receptionist expects
when somebody deleted by mistake walks back in. It is also not a way to hide a
duplicate: the old row is still there, still joined to its appointments.

---

## 9. Tenant isolation

Everything goes through `TenantScopedRepository`, so every query carries
`companyId` and RLS is set on the connection. Cross-tenant access returns
**404, never 403** — a 403 confirms the row exists.

| Attempt | Result |
|---|---|
| Read / update / delete another company's customer | `404` |
| Address it through *their* company path | `404` |
| Set another company's employee as preferred | `404`, nothing created |
| See another company's customer in a list | never returned |

`preferredEmployeeId` is validated before the row is written, so a create naming
a foreign employee leaves nothing behind — the composite foreign key would
refuse it anyway, but as a `500` nobody planned.

---

## 10. Audit

`customer.created`, `customer.updated` and `customer.deactivated`, through the
existing hash-chained `AuditService`.

Contact details **are** recorded, because "who changed this phone number" is a
real question. The free-text `notes` body is **not**: at a clinic that field
holds medical detail, and nobody audits it field by field. A test asserts the
note body never reaches the audit row.

---

## 11. Files

**Backend**

    apps/api/src/customers/dto/customer.dto.ts
    apps/api/src/customers/customers.service.ts
    apps/api/src/customers/customers.controller.ts
    apps/api/src/customers/customers.module.ts
    apps/api/prisma/migrations/20260909172339_customer_address/

**Frontend**

    apps/web/services/customers.service.ts
    apps/web/features/customers/{api,ui}/
    apps/web/app/(app)/customers/page.tsx
    apps/web/app/(app)/customers/[customerId]/page.tsx

---

## 12. Tests

`apps/api/test/customers.e2e-spec.ts` — **51 tests** against the real
application.

| Block | Covers |
|---|---|
| CRUD | create, read, update, name composition, normalisation, preferred employee |
| soft delete | archives not removes, frees the contact details, excluded from lists, refuses twice |
| duplicates | phone, email, different formatting, different case, on update, allowed across companies, ignored when deleted |
| validation | neither contact, malformed email/phone/date, unknown fields, `companyId` refused, statistics refused |
| search, filter, pagination | all four search columns, spaced phone number, status, tag, never-visited, paging, sorting |
| appointment history | newest first, counts, **the composite FK refusing a cross-company appointment**, 404 for another tenant's customer |
| tenant isolation | the table in §9, each asserting the database is unchanged afterwards |
| permissions | anonymous, READ_ONLY, RECEPTIONIST, EMPLOYEE, and the history's separate gate |
| audit | three actions recorded; the note body kept out |

Front end: `customer-list.test.tsx` (8) and `customer-form.test.tsx` (6),
covering loading, empty, error and duplicate-conflict states.

---

## 13. Not built here

Customer merging, the threaded `company_customer_note` table, consent
management, bulk export, public booking, payments, notifications, promotions,
gift cards and reports. `loyalty_points` is displayed and nothing awards it.
