# Invitations

How somebody joins a company.

Companion to [PROVISIONING.md](./PROVISIONING.md), which creates the company and
its first owner. This is what makes that owner's `requiresInvitation: true`
actionable, and how every member after them arrives.

This describes what was **built**, not what was planned.

---

## 1. The flow

```
admin  ──POST /members/invitations──▶  token + link  (returned once)
                                              │
                                    distributed by hand
                                              │
                                              ▼
recipient ──POST /invitations/preview──▶  "Company A wants you as RECEPTIONIST"
          ──POST /invitations/accept───▶  membership created
                                              │
                                              ▼
                            sign in normally at /auth/login
```

**Nothing is emailed.** There is no mail transport in the system yet, so rather
than pretend, the administrator receives the link and sends it themselves. When
the notification outbox lands in phase 6, sending becomes an extra side effect
of create — the tokens, the expiry and the state machine do not change.

---

## 2. Lifecycle

Status is **derived from three timestamps**, never stored:

```
                        ┌── accept ──▶ ACCEPTED   (accepted_at set)
                        │
PENDING ────────────────┼── revoke ──▶ REVOKED    (revoked_at set)
(none set, not past     │
 expires_at)            └── clock ───▶ EXPIRED    (expires_at passed)
```

Two consequences worth stating:

- **Expiry needs no scheduled job.** A row is expired the instant the clock
  passes `expires_at`, on every read, everywhere. There is no sweeper to fall
  behind and no window in which a stale row is still honoured.
- **Status cannot disagree with its own timestamps**, because there is no second
  place to write it. A `CHECK` constraint forbids the one impossible
  combination — accepted *and* revoked.

`ACCEPTED`, `REVOKED` and "no such token" are **indistinguishable in the API**.
See §6.

---

## 3. `POST /api/v1/members/invitations`

Create an invitation.

**Auth**: staff bearer token. **Permission**: `member:invite`. Also
`@RequiresWrite()`, so a read-only company refuses.

The company comes from the token's active company, not from the path. The
tenant resolver would validate a `/companies/{id}/...` path segment against
membership just the same, but for an administrator inviting their own colleague
there is no other company they could mean — leaving it out removes the question
rather than answering it.

### Request

```json
{
  "email": "colleague@example.com",
  "roleKeys": ["RECEPTIONIST"],
  "expiresInDays": 7
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string | ✅ | Valid address, ≤ 320 |
| `roleKeys` | string[] | ✅ | 1–10 keys, uppercase, must exist in **this** company |
| `expiresInDays` | int | | 1–30. Defaults to `INVITATION_TTL_DAYS` (7) |

Roles are named by **key**, not id. `company_role.key` is unique per company, so
within the tenant the request is already scoped to a key identifies exactly one
role — and there is no cross-tenant id to smuggle in. It is also the only usable
option today: no endpoint lists roles yet, so an id-based API would be
undiscoverable. Ids can be accepted alongside keys later.

At least one role is required. An invitation granting nothing produces a member
who can see the company exists and do nothing in it, which is never what the
inviter meant.

### Success — `201`

```json
{
  "data": {
    "id": "01a06c61-8b7b-7f63-8e26-4d19fcf267ec",
    "email": "colleague@example.com",
    "status": "PENDING",
    "roles": [{ "key": "RECEPTIONIST", "name": "Receptionist" }],
    "expiresAt": "2026-09-11T12:25:27.148Z",
    "createdAt": "2026-09-04T12:25:27.164Z",
    "acceptedAt": null,
    "revokedAt": null,
    "token": "UpkVuXaSH6U3s-3m_eVQp2AAi9KYChpjnub66l6u8Cg",
    "acceptUrl": "http://localhost:3001/invitations/accept?token=UpkVuXaS…"
  },
  "meta": { "requestId": "…" }
}
```

**`token` appears in this response and nowhere else, ever.** Only its HMAC is
stored, so the listing endpoint physically cannot return it and neither can a
database dump. If it is lost, rotate.

`acceptUrl` is built from the configured `WEB_APP_URL` and is omitted when that
is unset. It is **never** derived from the request `Host` header: host-header
injection would otherwise produce a link pointing at an attacker's domain, and
the recipient would hand over a valid one-time token by following it.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Bad email, empty `roleKeys`, unknown role key, expiry over 30 days |
| 401 | `UNAUTHENTICATED` | No token |
| 403 | `PERMISSION_DENIED` | Member without `member:invite` |
| 403 | `PRIVILEGE_ESCALATION_BLOCKED` | See below |
| 404 | `TENANT_NOT_FOUND` | Not a member of the target company |
| 409 | `CONFLICT` | Already a member, or a live invitation exists (`details.invitationId`) |

**Privilege escalation.** The union of permissions carried by the requested
roles must be a subset of what the inviter holds. Without this, `member:invite`
alone is a route to owner-equivalent access: invite an address you control,
attach `OWNER`, accept. The check is on **permissions**, not role names, because
what matters is the capability being handed over rather than the label on it.
`details.permissions` lists the keys to drop. Owners short-circuit — nothing can
exceed everything.

A live invitation conflict returns the existing `invitationId` so the UI can
offer "rotate instead" rather than a dead end.

---

## 4. `GET /api/v1/members/invitations`

**Permission**: `member:read`. Query: `status=live|all` (default `live`),
`limit` (≤ 100), `offset`.

Returns `{ items, total }`. **No `token` field exists in this shape.** Live
excludes accepted, revoked and expired.

---

## 5. `POST /api/v1/members/invitations/:id/rotate` · `DELETE /api/v1/members/invitations/:id`

**Permission**: `member:invite` for both.

**Rotate** is "resend the link", and it invalidates the previous token
immediately. That is the point: otherwise resending leaves two live credentials
where the administrator believes there is one, and revoking the visible one
closes nothing. It also revives an expired invitation. Returns the same shape as
create, with a fresh `token`.

**Revoke** sets `revoked_at`; the link stops working at once. `204`.

Revoke is gated by `member:invite` rather than `member:remove` — withdrawing an
invitation nobody accepted is part of inviting, not of removing a person.

Both `404` on unknown, already-accepted, already-revoked, **and another
company's invitation**. A successful cross-tenant rotate would silently kill a
live invitation in a company the caller cannot see, so this one is worth
asserting rather than assuming; a test does.

**Platform operators** may reach these routes via `@AllowPlatformAccess()` with
`X-Company-Id`. That closes a hole provisioning creates: a fresh company has
exactly one member who cannot sign in until they accept, so if their link is
lost there is nobody left to re-send it. TenantGuard still requires
`platform:company:data:*`, and every resulting audit row is flagged
`viaPlatformAccess`.

---

## 6. `POST /api/v1/invitations/preview`

**Public.** Body `{ token }`.

```json
{
  "data": {
    "companyName": "Company A",
    "companySlug": "company-a",
    "email": "colleague@example.com",
    "roles": [{ "key": "RECEPTIONIST", "name": "Receptionist" }],
    "expiresAt": "2026-09-11T12:25:27.148Z",
    "accountExists": false
  }
}
```

`accountExists` tells the accept screen which form to render: sign in, or choose
a password. Unauthenticated by necessity — the recipient may have no account.
It discloses the company and address to whoever holds the token, which is
exactly what the invitation grants, and nothing to anyone who does not.

---

## 7. `POST /api/v1/invitations/accept`

**Public.** Bearer token optional; consulted only when the address already has
an account.

### The token is in the body, not the path

`POST /invitations/{token}/accept` is the more familiar shape, and it is wrong
here. A URL is the least private part of an HTTP request: it is written to
access logs, proxy logs, browser history and the `Referer` header of every
subsequent request from that page. A one-time credential should not be recorded
in four places on its way in.

The link the recipient clicks is a **frontend** URL —
`{WEB_APP_URL}/invitations/accept?token=…` — which the web app reads and posts
here. Only the frontend origin ever sees it in a URL.

### Request

```json
{ "token": "UpkVuXaS…", "fullName": "New Colleague", "password": "a-perfectly-fine-password" }
```

`fullName` and `password` are required **only** when the address has no usable
account. The service decides, because it is the only side that knows — validating
it in the schema would mean telling an anonymous caller whether an email is
registered.

Passwords are ≥ 12 characters with no composition rules. Length is what resists
guessing; forced symbol classes mostly produce `Password1!`.

### Success — `200`

```json
{
  "data": {
    "companyId": "01a06c61-89af-7d82-9ead-515c6fc6f165",
    "companySlug": "company-a",
    "companyName": "Company A",
    "companyUserId": "01a06c61-be27-7d30-9fbd-1357ab8371fd",
    "email": "colleague@example.com",
    "roles": [{ "key": "RECEPTIONIST", "name": "Receptionist" }],
    "accountCreated": true
  }
}
```

**No tokens and no cookie.** Sign in normally afterwards. See §8.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | New account, but no password or no name |
| 401 | `INVITATION_SIGN_IN_REQUIRED` | The address already has an account |
| 403 | `INVITATION_EMAIL_MISMATCH` | Signed in, but as somebody else |
| 404 | `INVITATION_NOT_FOUND` | Unknown, revoked, already accepted, or a suspended/cancelled company |
| 410 | `INVITATION_EXPIRED` | Past `expires_at` |

---

## 8. Security

### Three properties cap the damage of a leaked link

An invitation travels over a channel nobody controls — pasted into chat,
forwarded, screenshotted. The design assumes it leaks and limits what that is
worth:

1. **Accepting never issues a session.** No tokens come back. A stolen link
   cannot be exchanged for access on its own.
2. **Accepting never sets a password on an existing account.** If the address
   already has one, the caller must *already be signed in as it*. Otherwise a
   leaked link would be a password reset for somebody else's account.
3. **The membership binds to the invited address**, not to whoever is signed in.
   Without that, an administrator of company B who clicks a leaked link gets
   silently added to company A.

What remains: whoever holds the link can create an account for an address they
may not own and join one company as a non-owner with the roles the inviter
chose. That is the irreducible cost of link-based invitations, and it is why the
token is 256 bits, single-use, rotatable and short-lived.

### One answer for every dead token

Unknown, revoked and already-accepted all return `INVITATION_NOT_FOUND` with a
byte-identical body. If "revoked" were distinguishable from "never existed", a
stolen token would confirm that an invitation for that address had once been
issued — which confirms the address, the company, and that someone thought that
person belonged there.

Expiry is the single exception, and deliberately so: it is the only failure a
legitimate recipient can act on, and it leaks nothing an attacker could not
learn by waiting.

### `isOwner` is unreachable

No invitation can confer ownership. The accept path writes `isOwner: false` as a
literal; the only code that writes `true` is `CompanyProvisioningService`.

### `@Public()` disables PermissionGuard entirely

Including `@RequiresWrite()`. So the accept routes get **no** company-status
check from the guard chain, and `InvitationAcceptService` makes it by hand —
suspended, cancelled and soft-deleted companies are refused there. That check
must stay in the service.

### Enumeration

`assertNotAlreadyAMember` joins through `user_account`, which the tenant
connection can only see through the membership RLS policy. It can therefore
observe an account only if that account is already a member *here*, so a
non-member's existence is not disclosed and the endpoint is not an
account-enumeration oracle.

---

## 9. Atomicity

Acceptance runs in one transaction on the tenant connection:

```
updateMany(accepted_at: null → now)   ← compare-and-swap, claims the invitation
        ↓  count = 0 means somebody else won: roll back, 404
create membership + role assignments
        ↓
commit
```

The claim comes **first** deliberately. Two simultaneous accepts of one link
produce one membership, not two — the loser rolls back having written nothing.
The unique index on `(company_id, user_account_id)` is the second line of
defence. A test fires three concurrent accepts and asserts exactly one `200` and
exactly one membership row.

If the membership write fails, the invitation stays `PENDING`. That matters: if
`accepted_at` stuck on a failed attempt, the link would be dead and the person
permanently unable to join. A test induces this with a real unique-constraint
violation and asserts the row is still claimable.

**The one gap, stated honestly.** Account creation happens on the *platform*
connection and cannot join this transaction — `user_account` carries FORCE RLS
with a SELECT-only policy, so it is unwritable from the tenant connection. The
order is chosen so a crash between them is recoverable: the account is created
first and is idempotent by email, the invitation is still live, and a retry
finds the account and completes. An account with no membership can reach no
company, so the intermediate state is inert.

---

## 10. Provisioning handshake

An invitation may carry a `company_user_id`, which provisioning sets when it
pre-creates the owner's `INVITED` membership. Accepting then **activates that
row** rather than creating a second one — status becomes `ACTIVE`, `joined_at`
is set, `isOwner` and the roles assigned at provisioning time are untouched.

If the owner's account is a placeholder (created by provisioning with no
password), accept fills the password in. That is not a password reset: there was
never a password and no session was ever possible. The
`passwordHash: null` predicate on that update is what keeps it true — if the
account has since acquired one, the update matches nothing and the caller is
routed to sign in instead.

---

## 11. Audit

| Action | Resource | Level |
|---|---|---|
| `member.invited` | `company_invitation` | company |
| `member.invitation_rotated` | `company_invitation` | company |
| `member.invitation_revoked` | `company_invitation` | company |
| `member.invitation_accepted` | `company_user` | company, via `recordForCompany` |

Acceptance uses `AuditService.recordForCompany` because the route is
`@NoTenant()` — ordinary `record()` would file "someone joined" as a
platform-level row with `company_id` NULL, which RLS then hides from the very
company it happened to.

**No audit payload ever contains a token.** `redact()` would catch a key named
`token`, but relying on a denylist for a live credential is the wrong posture;
the safe move is not to put it in the object.

---

## 12. Trying it

```bash
pnpm db:seed:demo
```

Sign in as `user-a@example.com` (password printed by the seeder), then:

```bash
curl -s -X POST http://localhost:3000/api/v1/members/invitations -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"email":"colleague@example.com","roleKeys":["RECEPTIONIST"]}'
```

Take `token` from the response and accept it with no authentication at all:

```bash
curl -s -X POST http://localhost:3000/api/v1/invitations/accept -H 'Content-Type: application/json' -d '{"token":"<token>","fullName":"New Colleague","password":"a-perfectly-fine-password"}'
```

Then sign in as `colleague@example.com` and call `GET /api/v1/me/context` to see
the receptionist permission set.

---

## 13. Not built yet

- **Email.** The whole point of the manual link. Phase 6.
- **Email verification.** `emailVerifiedAt` stays null: a link distributed by
  hand proves nothing about who controls the address, only that whoever accepted
  had the link.
- **Rate limiting on the public routes.** Tokens are 256 bits so guessing is not
  a threat, but `preview` and `accept` are unauthenticated endpoints that touch
  the database. Redis is wired and optional; the limiter is not built.
- **Member and role administration** — listing members, changing roles,
  suspending, removing, and CRUD for custom roles. Next milestone.
