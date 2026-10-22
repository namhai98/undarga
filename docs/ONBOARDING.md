# Company onboarding

How a company gets from "nothing" (or "provisioned, never set up") to "ready to
take bookings". The backend is `apps/api/src/onboarding/`; the wizard is
`apps/web/features/onboarding/` at `/onboarding`.

---

## 1. Two ways in, one wizard

| Path | Who | Creates | Ends at |
|---|---|---|---|
| **Self-serve** | any signed-in staff account | company, settings, six system roles, the CALLER as ACTIVE owner, first branch, opening hours, default-plan trial | `IN_PROGRESS` |
| **Provisioned** | the owner of a company an operator created (`docs/PROVISIONING.md`) | business details, first branch, opening hours; `PENDING_SETUP` becomes `ACTIVE` | `IN_PROGRESS` |

Either way, step 4 (`complete`) adds the optional initial services and marks the
company `COMPLETED`.

There is still no account registration. Onboarding creates a company for an
account that already exists — one that accepted an invitation, or was left with
no company. Creating accounts stays with invitations
([AUTHENTICATION.md §12](./AUTHENTICATION.md)).

## 2. API

| Method | Path | Authorization |
|---|---|---|
| `POST` | `/onboarding/company` | signed-in staff (no company needed) |
| `GET` | `/onboarding/status[?companyId=]` | signed-in staff; membership verified |
| `GET` | `/onboarding/slug-availability?slug=` | signed-in staff |
| `POST` | `/onboarding/companies/:companyId/setup` | member with `company:write`, `settings:write`, `branch:write` |
| `POST` | `/onboarding/companies/:companyId/complete` | member with `company:write`, `service:write` |

All are staff-realm. A platform token is refused at the audience check like on
every staff route, and nothing is anonymous. `POST /onboarding/company` is
rate-limited to 5 a minute, because each call starts a trial.

### Body of `POST /onboarding/company`

```json
{
  "company":  { "displayName": "Nomin Spa", "legalName": "Nomin LLC", "slug": "nomin-spa" },
  "branch":   { "name": "Central", "code": "MAIN", "timezoneName": "Asia/Ulaanbaatar",
                "phone": "+97699112233", "addressLine1": "Peace Ave 1", "city": "Ulaanbaatar" },
  "business": { "currencyCode": "MNT", "contactEmail": "hello@nomin.mn", "contactPhone": "…",
                "registrationNumber": "…", "taxNumber": "…", "locale": "mn-MN",
                "businessHours": [{ "dayOfWeek": 1, "isClosed": false, "opensAt": "09:00", "closesAt": "18:00" }] }
}
```

- **Validation reuses the existing rules.** The slug follows provisioning
  (lowercase DNS label, reserved names such as `admin` and `platform` refused).
  Branch code, address and opening hours follow the branches module. The
  timezone and currency are checked against their reference tables, so an
  unknown one is a 400 naming the field rather than a foreign-key 500.
- **Timezone.** The branch timezone is also the company default.
- **Opening hours** are optional; days left out are closed. They are written by
  the same helper the branches module uses (`branches/business-hours.ts`).
- **Strict body.** Every schema is `.strict()` and none has an owner, user or
  company-id field, so `{"owner": {...}}` is a 400.

### Body of `complete`

```json
{ "services": [{ "name": "Haircut", "category": "Hair", "durationMin": 45,
                 "priceMinor": "3500000", "isActive": true }] }
```

- At most 20 services, with unique names.
- A category is matched by name, case-insensitively, at the top level, and
  created on first use.
- Each service is in the company currency and offered at every branch.
- Each one passes the plan's `MAX_SERVICES` check, under its advisory lock.
- `{}` or `"services": []` is the skipped step.

## 3. Transactions

**Create** is a single transaction:

- `CompanyProvisioningService.createForAccount` runs the same transaction as
  operator provisioning: company, settings, roles, owner and trial (#19's
  `startSubscription`, unchanged).
- Onboarding passes a `setup` callback that writes the first branch and hours
  inside that transaction.
- A failure anywhere rolls all of it back. The e2e suite forces a failure
  *after* the branch is written and asserts that every table's row count is
  unchanged.

**Setup** and **complete** each run in one tenant transaction (RLS applies). An
invalid service list creates no services and leaves the company `IN_PROGRESS`.

**Why services are not part of create.** They are optional, and plan limits
are read from committed state: `EntitlementsService` cannot see a company that
does not exist yet. So step 4 runs once the company is real, against the normal
`assertCanAdd`.

## 4. Who becomes the owner, and what about their email

- **The owner is the caller's account, taken from the verified token** — never
  from an email in the body. Nobody can make someone else the owner of a
  company, or take over an existing account by naming its address.
- **No duplicate accounts.** An account that already belongs to companies keeps
  being one account. The e2e suite checks there is exactly one `user_account`
  per email afterwards.
- **The membership** is `ACTIVE` immediately, `isOwner: true`, with the `OWNER`
  system role. The account must still be `ACTIVE` and not deleted when the
  transaction runs: a token outliving a disable cannot found a company.
- **At most 10 companies per account.** Creation is refused with a 409 once an
  account owns 10 active companies (`MAX_OWNED_COMPANIES`). Every company is a
  paid-plan trial.

## 5. Onboarding state

`company.onboarding_status` (`NOT_STARTED | IN_PROGRESS | COMPLETED`) and
`onboarding_completed_at`. Migration `20261008090000_company_onboarding` adds
them and marks every existing company that has a branch as `COMPLETED`.

| Status | Meaning | `nextStep` |
|---|---|---|
| `NOT_STARTED` | provisioned; no setup yet (or `company: null`: the account has no company) | `BRANCH` (or `COMPANY`) |
| `IN_PROGRESS` | company, branch and business settings done | `SERVICES` |
| `COMPLETED` | finished; services added or skipped | `null` |

**It is guidance, never a gate.**

- No API route refuses anything because onboarding is unfinished.
- The platform realm never reads it.
- The web shell's `OnboardingGate` sends only members with `canManage` back to
  `/onboarding`, and never from `/select-company` or `/no-company`. A
  receptionist in an unfinished company is not trapped in a wizard they cannot
  complete.

## 6. Tenant safety

- **No trusted company id from the client.**
  - `create` has no company yet.
  - `setup` and `complete` use the id TenantGuard resolved from `:companyId`,
    after its membership check.
  - `status` calls `MembershipService.authorize`, the guard's own check, on
    whatever id it reports on.
  - Another tenant's id is a 404 (`TENANT_NOT_FOUND`), indistinguishable from a
    company that does not exist.
- **Company RBAC applies.** The step routes need the same permissions as the
  branch, settings and catalog writes they stand in for. OWNER and ADMIN hold
  them; a RECEPTIONIST gets 403.
- **The platform connection.** The self-serve create runs on it only inside
  `CompanyProvisioningService`, which is already allowlisted for that
  connection. No new lint exemption was added. Every write in it names the new
  company's id.

## 7. The wizard

| Step | Fields |
|---|---|
| 1 Company | name, legal name, identifier (follows the name until edited; live availability check) |
| 2 Branch | name, address, city, phone, timezone (defaults to the browser's) |
| 3 Business | currency, contact email/phone, registration and tax numbers, optional opening hours |
| 4 Services | rows of name, category, duration, price, active; **Skip for now** |
| 5 Done | confirmation, then the dashboard after 4 s (or at once via the button) |

- **Steps 1–3 stay in memory** and are sent together at the end of step 3
  (create, or `setup` for a provisioned company, whose identifier is
  read-only).
- **Switching in.** After create, the wizard switches into the new company
  through `POST /auth/switch-company`, the same call the company switcher uses.
- **Resuming.** Leaving during step 4 resumes there next time.
- **Server errors.** A rejected field takes the user back to the step it
  belongs to.
- **Entry points.**
  - `/no-company`: **Create your company**.
  - `/select-company`: **Create another company** (`/onboarding?new=1`).
  - The gate, for unfinished companies.

## 8. Not done

- **Logo.** A `file` table and `company_branding.logo_file_id` exist, but there
  is no upload endpoint or storage, so step 1 says a logo can be added later.
- **Plan choice.** Every new company gets the default trial (PRO, 14 days). The
  plan is changed afterwards on the subscription page.
- **Account registration.** Out of scope; see §1.
