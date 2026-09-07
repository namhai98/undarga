# Employee Management

The people a company books work against.

Companion to [COMPANY-BRANCHES.md](./COMPANY-BRANCHES.md). This describes what
was **built**, not what was planned.

---

## 1. Endpoints

All nested under `/companies/:companyId/employees`, all `employee:read` or
`employee:write`.

| Method | Path |
|---|---|
| `GET` `POST` | `/employees` |
| `GET` `PATCH` `DELETE` | `/employees/:employeeId` |
| `GET` `POST` | `/employees/:employeeId/branches` |
| `DELETE` | `/employees/:employeeId/branches/:branchId` |
| `GET` `POST` | `/employees/:employeeId/services` |
| `DELETE` | `/employees/:employeeId/services/:serviceId` |
| `POST` `DELETE` | `/employees/:employeeId/account` |

---

## 2. Employee is not User

A `user_account` is a **login**. An `employee` is somebody a **customer can
book**. Most salons have people in exactly one of those sets — a stylist who
never touches the dashboard, a bookkeeper who never appears on a booking page —
so `employee.userAccountId` is nullable and no employee is forced to have an
account.

Where they overlap, the source of truth is split deliberately:

| Field | Owner | Why |
|---|---|---|
| `displayName` | **Employee** | What a calendar and a booking page show, frequently not a legal name — a stage name, a mononym, a transliteration. Must be editable without touching the person's account, and survives unlinking. |
| `email` | **User account** | There is no email column on `employee`, on purpose. Two copies of an address is two things to keep in step, and the one that matters is the one you sign in with. An unlinked employee simply has no email. |
| `phone` | **Employee profile** | The work number a colleague rings — genuinely a different fact from the personal number on the account. |
| `avatar` | **Employee profile** | A booking-page portrait is not the same picture as a dashboard avatar. |

There is no `firstName`/`lastName`. The schema has neither, and splitting a name
would force every consumer to reassemble it and get the order wrong in half the
world's locales.

### Linking a login

`POST /employees/:id/account` creates or reuses a `user_account`, links it, and
issues an invitation — reusing `InvitationsService` and `IdentityRepository`
rather than reimplementing either, so there is one account-creation path.

The company **membership is created when the invitation is accepted**, not at
link time. That is what accepting means.

Because it goes through the invitation flow it inherits its rules: it needs
`member:invite` as well, and the **privilege-escalation check applies** — an
administrator cannot hand out permissions they do not hold themselves. Granting
somebody a login *is* inviting them, so it is gated identically.

No password is ever accepted or generated. The response carries a one-time link.

> **A consequence worth knowing.** Between linking and accepting, the account
> row is invisible to the tenant connection — `user_account` is only reachable
> through the `user_account_via_membership` RLS policy. So the API reports
> `account: { userAccountId, email: null, status: 'PENDING_ACCEPTANCE' }`
> rather than pretending there is no account. That is the policy working, and
> it is exactly the state a "resend invitation" button keys off.

`DELETE /employees/:id/account` **only unlinks**. The account is not deleted and
the membership is not revoked: the person may belong to other companies, and
their login is theirs. Removing their access is `DELETE /members/:id`, a
different decision with a different permission.

---

## 3. Job title is not a role

```
jobTitle: "Senior Stylist"   →  what they do for customers
roleKeys: ["EMPLOYEE"]       →  what they may do in this application
```

Different tables, different endpoints, different code. Nothing in this module
reads a job title to make an authorization decision, and nothing reads a role to
render a booking page. Conflating them is how a promotion becomes a privilege
escalation; a test sets `jobTitle: "OWNER"` and asserts it changes nothing.

---

## 4. Status, and the second axis

| Status | Meaning |
|---|---|
| `ACTIVE` | Working, and offered slots if `isBookable`. |
| `ON_LEAVE` | Still employed, temporarily not offered slots. Distinct from INACTIVE because reporting should still count them as staff. |
| `INACTIVE` | Not working, not offered slots, record retained. |
| `TERMINATED` | Employment ended. Historical records stay intact. |

`isBookable` is a **separate axis** and both are needed: a manager may be ACTIVE
and never bookable, and a stylist may be temporarily un-bookable without any
change to their employment. The availability engine will read both. Nothing
reads them yet.

---

## 5. Soft delete

`DELETE` sets `deletedAt`, `status: TERMINATED` **and `isBookable: false`**.

The row stays because `appointment_item`, promotions and customer preferences
reference this person — removing it would either fail on a foreign key or
cascade through booking history and the revenue attributed to them.

The `isBookable: false` is belt and braces on the one mistake customers would
see: a future availability engine that forgets to filter on `deletedAt` still
cannot offer a deleted employee.

---

## 6. Employee codes

Optional, uppercased, unique **within a company**:
`(company_id, employee_code) WHERE deleted_at IS NULL AND employee_code IS NOT
NULL`.

Tenant-local for the same reason branch codes are — `EMP-001` is a customer's
own numbering. Nulls do not collide, so any number of employees may have no
code, and deleting releases one for reuse.

---

## 7. Branches

Many-to-many through `employee_branch`. `employee.companyId === branch.companyId`
is enforced three times over: in the service by looking the branch up with the
resolved company in the filter, in the database by the composite foreign keys
`(company_id, employee_id)` and `(company_id, branch_id)`, and by RLS beneath
both. The application check exists so the answer is a **404** rather than a
constraint violation.

Branch ids supplied at creation are validated **before** the employee row is
written, so a request naming a foreign branch leaves nothing behind.

**Exactly one primary branch**, always. The first branch assigned becomes
primary; removing the primary promotes another. An employee with branches but no
primary is a state the schedule engine would have to invent a rule for.

---

## 8. Services

Many-to-many through `employee_service`, with optional per-employee duration and
price overrides.

The `service` table exists in the schema but **nothing creates rows in it yet** —
Service Management is a separate module. These endpoints are the other half of
that relationship, built now so it is not bolted on afterwards, and they
validate against whatever services exist. Tests seed service rows directly.

Price overrides are minor units as a **string** on the wire. The column is
BigInt; above 2^53 a JS `Number` silently rounds, and a price is exactly the
value that must not.

### The query this shape exists for

`GET /employees?branchId=…&serviceId=…` filters through both join tables in SQL.
That is the same question the availability engine will ask — *who can do this,
here?* — so the relationship and the indexes are already the right shape.

---

## 9. Search, filter, pagination

Everything is a SQL predicate. Loading a company's staff into memory to filter
them would work for a salon with six people and fall over for a chain with six
hundred, which is the customer worth keeping.

| Parameter | Notes |
|---|---|
| `search` | Display name, employee code, work phone — case-insensitive |
| `status`, `isBookable`, `hasAccount` | |
| `branchId`, `serviceId` | Through the join tables |
| `sortBy`, `sortOrder`, `limit`, `offset` | `total` is the whole result set, not the page |

**Email is deliberately not searchable.** It lives on `user_account`, which the
tenant connection sees only through the membership RLS policy — so the same
query would match a colleague who has accepted their invitation and silently
miss one who has not. A search whose results depend on somebody else's
onboarding state is worse than one that never claimed to cover the field.

The query schema is strict, so an unknown parameter — `?companyId=…` — is a 400
rather than a silently ignored attempt.

---

## 10. Public and private profile

The detail response splits them, and the list returns neither private field:

```
publicProfile   displayName, jobTitle, bio, avatarFileId, languages, specialties
privateProfile  phone, emergencyContact
```

`emergencyContact` lives on the same row as `jobTitle` and `bio`. The list is
what a receptionist loads all day, and a next-of-kin phone number has no
business being in it — a spread of the row is exactly how it would get there, so
responses are shaped by hand and a test asserts the number never appears.

---

## 11. Audit

`employee.created` · `employee.updated` · `employee.deactivated` ·
`employee.branch_assigned` · `employee.branch_removed` ·
`employee.service_assigned` · `employee.service_removed` ·
`employee.user_linked` · `employee.user_unlinked`

All company-level. The invitation token is never in a payload — a test asserts
it.

---

## 12. Frontend

`services/employees.service.ts`, `features/employees/` (hooks + list UI), and
`/staff`. Search, status and branch filters, pagination, loading, empty and
error states. Deliberately plain: this is the foundation later screens build on,
and over-designing it now would mean throwing the design away twice.

`useCan('employee:write')` hides the add button. The API refuses it regardless —
the web app hides buttons, the API decides
(`docs/ARCHITECTURE-RULES.md` rule 3).

---

## 13. Not built yet

- **Service Management.** The assignment endpoints work; nothing creates
  services.
- **Avatar upload** — needs the file module.
- **Schedules, time off, availability.** `employee_schedule`,
  `employee_schedule_exception` and `employee_time_off` all exist and are
  untouched. Nothing here binds an employee to a single global schedule: the
  branch relationship is many-to-many, so branch-specific schedules remain
  possible.
- **Branch-level access enforcement.** `company_user_branch` is on the request
  context as `membership.branchScope` and unused.
