# Authentication & the login flow

How somebody signs in, stays signed in, and ends up inside the right company.

Companion to [PROVISIONING.md](./PROVISIONING.md) and
[INVITATIONS.md](./INVITATIONS.md), which are how an account comes to exist in
the first place. This describes what was **built**, not what was planned.

---

## 1. Where the session lives

Two halves, stored very differently, and the split is the whole design:

| | Where | Lifetime | Readable by JS |
|---|---|---|---|
| **Access token** | memory (`tokenStore`) | 15 min | yes |
| **Refresh token** | `HttpOnly` cookie | 30 days | **no** |

The refresh token is the valuable one — it mints access tokens for a month — so
it is never returned in a response body and never touched by client code. The
API sets it as `undarga_rt`, `HttpOnly; SameSite=Lax; Path=/api/v1/auth`, and
reads it back off the request.

**`Path` is the load-bearing attribute.** The cookie is attached to login,
refresh, logout and switch-company, and to nothing else. Every other endpoint is
bearer-only and carries zero ambient authority, so there is nothing for a forged
cross-site request to ride.

**There is no CSRF token, deliberately.** `SameSite=Lax` is not a mitigation
here, it is the defence: a cross-site POST does not carry the cookie at all, so
a forged refresh fails before it reaches us. CORS is an exact-origin allow-list,
so an attacker cannot read a response either. A double-submit token would have
to be readable by JavaScript on the *web* origin while being set by the *API*
origin — across subdomains that means widening it with `Domain=` — and it would
have to exist before the bootstrap refresh, which by definition runs holding
nothing. That is a lot of moving parts to cover an attacker who already controls
a sibling subdomain.

> Ports are not part of a site. `localhost:3001` → `localhost:3000` is
> same-site, as is `app.example.com` → `api.example.com`. Different **origin**
> is not different **site** — do not reach for `SameSite=None` merely because
> the origins differ. A genuinely cross-site deployment would need `None`, and
> at that point Lax stops protecting anything and a CSRF token becomes
> necessary. `SessionCookieService` carries that note.

What an XSS can still steal is the access token: fifteen minutes, one company,
one session. That is the trade, made knowingly.

---

## 2. Startup

```
page load
   │
   ├─ status: 'loading'          ← nothing may redirect yet
   │
   ▼
apiClient.ensureSession()  ──POST /auth/refresh (cookie only)──▶
   │
   ├─ 200 → access token in memory → status: 'authenticated'
   │        └─ GET /auth/me         → user + memberships
   │        └─ GET /me/context      → company + permissions   (only if a company is active)
   │
   └─ 401 → status: 'anonymous'
```

Two properties worth stating, because both are easy to get wrong:

**`loading` is a real state.** A guard that treats "not yet known" as "signed
out" flashes the login screen on every reload for users who are perfectly
authenticated. `RequireSession` renders a skeleton instead.

**The bootstrap goes through the same single-flighted refresh a 401 uses.**
`reactStrictMode` double-invokes effects in development, and two refreshes under
token **rotation** means the second presents an already-rotated token — which
the API correctly treats as theft and answers by killing the entire session
family. The symptom is "users get randomly logged out on page load", and the
cause is three layers away from it. There is a test for exactly this.

---

## 3. Which company

```
login
  │
  ├─ 0 memberships  → /no-company     explain; there is no self-serve signup
  ├─ 1 membership   → /dashboard      no picker for a choice of one
  └─ 2+ memberships → /select-company choose deliberately
```

The API does pick a default active company on login, so the multi-company case
could skip the picker. It should not: somebody who administers two salons and
silently lands in whichever one sorts first will edit the wrong one.

On a later **reload** there is no picker, because the session remembers the
company they actually chose — `user_session.active_company_id`, re-validated
against live memberships on every rotation so a revoked membership cannot ride
through it.

Switching calls `POST /auth/switch-company`, which issues a new token pair and
retires the old session. A token is valid for exactly one company; there is no
window in which it means two things.

---

## 4. Cache and tenant isolation in the browser

Switching company calls `queryClient.clear()`, **not** `invalidateQueries()`.

Invalidate marks data stale but keeps it, and React re-renders the stale value
while the refetch is in flight — so the previous tenant's members and
appointments get painted on screen under the new company's name. The backend
spends four layers of effort making cross-tenant reads impossible; reintroducing
one in a browser cache would be a strange place to stop.

Queries are cancelled first, so a request already in flight for the old company
cannot resolve after the clear and repopulate the cache with it. Company-scoped
query keys also carry the company id, so a missed clear degrades to a cache miss
rather than a leak.

`SessionCacheBridge` subscribes to the token store and clears on any change
except `refreshed`. That covers the case no mutation handler can: the API client
clearing the session from outside React entirely, when a refresh comes back
`REFRESH_TOKEN_REUSED` or `SESSION_REVOKED`.

---

## 5. Routing

```
app/
  (public)/login                    ?next= ?email=
  (public)/invitations/accept       ?token=
  (app)/dashboard
  (app)/select-company
  (app)/no-company
```

`(app)/layout.tsx` wraps everything in `RequireSession`.

**A client guard, not middleware.** Middleware runs on the Next origin and can
only read cookies set for it; the refresh cookie is set by the API host, scoped
to `/api/v1/auth`, and in production is on a different host entirely — so
middleware would see nothing. Even where it could, cookie presence proves only
that a cookie exists, not that the session is valid, and gating on that would be
a client-side authorization decision.

The consequence is honest: everything under `(app)` is client-rendered. With no
server-side token to fetch with, it could not have been otherwise.

**`?next=` is validated before any navigation.** It comes from the URL, so
`/login?next=https://evil.example` would otherwise turn the login screen into an
open redirect — a credible phishing primitive precisely because the first hop is
a domain the victim trusts and they arrive having just typed a password.
`isSafeReturnPath` requires a single leading slash; `//evil.example` is rejected
too, because browsers treat protocol-relative URLs as absolute.

---

## 6. The invitation path

```
invitation link  →  /invitations/accept?token=…
                          │
                          ├─ no account      → choose a name and password
                          ├─ account exists  → "sign in first", link carries the email
                          └─ signed in as the invitee → one button
                          │
                          ▼
                    membership created (no session issued)
                          │
                          ▼
                    /login?email=…  →  dashboard
```

**Accepting returns no tokens**, so a stolen link cannot be exchanged for a
session. The user signs in normally afterwards.

The token reaches the API in a **request body**, never a path. The link itself
has to carry it in a query string — it must survive being pasted into a chat
window — but that is as far as it travels: the page reads it, posts it, and the
API never writes it to an access log or a `Referer` header. The accept page sets
`referrer: 'no-referrer'` and `robots: noindex` for the same reason, and the
spent token is **not** carried into the follow-up login URL.

The token is also kept out of TanStack Query keys, which are visible in devtools
and serialised into any devtools export.

---

## 7. Errors

| Situation | What the user sees |
|---|---|
| Wrong password **or** unknown email | "Those details did not work" — one message |
| Network failure | "Could not reach the server" |
| 5xx | "Something went wrong on our side" |
| Expired session | Silently refreshed; if that fails, back to login |
| Revoked / reused refresh token | Signed out, cache cleared, back to login |
| Expired invitation | "This invitation has expired" — actionable |
| Revoked, used or unknown invitation | "No longer valid" — one message for all three |

Two rules behind that table.

**Never distinguish "no such account" from "wrong password".** The API
deliberately does not, so that login cannot be used to discover which addresses
are registered. Saying "unknown email" in the UI would give away exactly what
the server withheld. A test asserts the message contains no such wording.

**Never surface a raw backend message.** They are written for operators and can
name internals. A test feeds the form a `PrismaClientKnownRequestError` and
asserts the word "Prisma" does not reach the screen.

Expired invitations are the one deliberate exception to the single-message rule:
expiry is the only failure a legitimate recipient can act on, and it leaks
nothing an attacker could not learn by waiting.

---

## 8. Logout

1. `POST /auth/logout` — revokes the session, expires the cookie
2. clear the in-memory access token
3. clear every cached query
4. back to `/login`

Steps 2–4 run in `onSettled`, so they happen **whether or not the server call
succeeded**. The risk is asymmetric: ending a session that is already dead costs
nothing, while leaving one alive on a shared machine is the actual harm.

Step 3 is not housekeeping. The cache holds one company's members and customers;
leaving it means the next person to sign in on that machine sees the previous
tenant's data rendered from memory before their own arrives.

---

## 9. Account recovery

| Endpoint | Auth | Rate limit |
|---|---|---|
| `POST /auth/forgot-password` | public | 3/min/IP |
| `POST /auth/reset-password` | public | 10/min/IP |
| `POST /auth/resend-verification` | public | 3/min/IP |
| `POST /auth/verify-email` | public | 10/min/IP |
| `POST /auth/change-password` | bearer | 5/min/IP |
| `POST /auth/logout-all` | bearer | default |

### One table, two purposes

`user_token` carries both email-verification and password-reset links. The
lifecycle is identical — issue, hash, expire, consume once — and the only thing
that differs is what consuming it does. Two tables would be two places to get
expiry or single-use wrong.

Only the HMAC is stored, using the same `TokenHashService` as refresh tokens and
invitations. RLS closes the table to tenant connections outright: a tenant
connection able to read it could reset any account on the platform.

Reset links live **30 minutes**, verification links **24 hours**. Reset is far
shorter deliberately — it takes over an account, so the window in which a leaked
inbox is dangerous should be measured in minutes.

### Single use is a compare-and-swap

`UPDATE … WHERE consumed_at IS NULL`, and a count of zero means somebody else
got there first. Checking in the service and then updating would leave a window
where two concurrent requests both pass the check.

Issuing a new link retires the previous one, so clicking "resend" three times
leaves one working link rather than three.

### The two `request` endpoints reveal nothing

`forgot-password` and `resend-verification` answer `202` with a byte-identical
body whether or not the address has an account. An endpoint that answered
differently is an account-enumeration oracle, and the list it yields is exactly
the input for a credential-stuffing run. They also send nothing for an account
that has never set a password — a provisioning placeholder belongs in the
invitation flow, not the reset flow.

The endpoints that *consume* a token do report failure, and rightly: the caller
is holding a token rather than guessing an address, so there is nothing to
enumerate. `ACCOUNT_TOKEN_EXPIRED` is distinguished from
`ACCOUNT_TOKEN_INVALID` because expiry is the only failure a legitimate
recipient can act on.

A verification token cannot be spent as a reset token. If it could, the
longer-lived, more freely sent link would be an account takeover.

### What a reset does to sessions

**Every session dies, including the caller's.** If the password leaked, so did
every session it created; changing the credential while leaving those alive puts
the attacker exactly where they were.

A *change* is different: other sessions are revoked and the caller's is kept, so
the ordinary case is not "you changed your password, now sign in again on the
device in your hand". The current password is required even though the caller is
already authenticated — a token left open on a shared machine must not be enough
to lock the owner out.

Revocation happens in two places, covering different windows: the database
revocation stops the next refresh, and the in-process deny list stops the access
token already issued. The deny list is per-replica, so behind more than one
instance revocation is immediate on the replica that handled it and takes effect
elsewhere at the next refresh.

### Delivery is a stub, and only delivery

There is no mail transport. `MailerService` is the seam where one goes; today it
logs the link at warn level **in development only**. In production it logs that
mail would have been sent, to a redacted address, and never the link — a reset
link is a credential, and logging one would put account takeover into whatever
aggregates the logs.

Everything with a security property — token generation, hashing, expiry, single
use, enumeration resistance — is real and tested now.

---

## 10. Rate limiting

Two ceilings on different axes, because neither is sufficient alone.

**Per IP** (`ThrottlerGuard`, registered before authentication so it sees
unauthenticated routes). Stops credential stuffing: one attempt each against ten
thousand addresses never trips a per-account lockout, and this makes it
expensive.

**Per account.** The existing login lockout (10 failures → 15 minutes) and a
ceiling of five links per purpose per 15 minutes in `AccountService`. An
attacker with a botnet defeats the IP limit and not these. The link ceiling
fails *silently* — same status, same body — so it cannot be used to probe
whether an address is being targeted.

The IP limiter uses in-memory storage, so it is **per replica**: behind three
instances the effective limit is three times the configured one. The fix is a
Redis store, deferred because Redis is optional here by decision and a limiter
that silently stops working when Redis is down would be worse than one that is
honestly approximate.

`THROTTLE_ENABLED=false` turns it off, which exists so the test suite is not
flaky — low limits plus one source address would make each test's outcome depend
on how many ran before it.

---

## 11. Mass assignment

`PATCH /users/me` accepts `fullName`, `phone` and `locale` and **rejects**
anything else with a 400 rather than dropping it silently — an attempt should be
visible to the client, not a no-op the attacker retries differently.

This matters because `status`, `emailVerifiedAt` and `passwordHash` all live on
the same table. A permissive body is exactly how one of them becomes settable
from a profile edit; a test asserts that each is refused, and that
`emailVerifiedAt` in particular cannot be self-set.

The repository writes those three fields explicitly rather than spreading the
DTO, so even a schema mistake would not reach the column.

---

## 12. What is deliberately not here

**Self-serve registration.** There is no `POST /auth/register`, and that is an
architectural decision rather than an omission: companies are provisioned by a
platform operator, and people join through invitations. Adding self-serve signup
would create a second, contradictory onboarding path and would need the plan and
trial decisions that are still open. The equivalent of "registration" — creating
the account, setting the password, attaching the membership — is
`POST /invitations/accept`, covered in [INVITATIONS.md](./INVITATIONS.md).

**MFA, SSO, OAuth.** None are half-built; there are no stubs to trip over. MFA
matters most for the platform realm: `AuthService.loginPlatform` logs an error
saying that realm should not reach production without a second factor, which is
why provisioning is API-only and there is no operator console.

**Changing your own email address.** It is absent from the profile schema on
purpose — the new address has to be verified before it can be signed in with,
which is a flow of its own rather than a field edit.

---

## 13. Trying it

```bash
pnpm db:seed:demo
```

Then sign in at <http://localhost:3001/login>:

| Account | What it demonstrates |
|---|---|
| `user-a@example.com` | one company — straight to the dashboard |
| `user-ab@example.com` | two companies — the picker, then switching |

Password is printed by the seeder. Reload the page after signing in: the session
survives, and so does the company you picked.
