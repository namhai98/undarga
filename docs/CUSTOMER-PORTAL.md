# Customer portal

A customer's own bookings, payments, gift cards and profile at one business.

- **Web:** `/portal/<companySlug>` (linked from the booking confirmation as
  "Manage my bookings").
- **API:** `apps/api/src/customer-portal/`, using the customer token realm that
  already existed in `auth/token.types.ts`.

---

## 1. Signing in: a code to the email on file

Customers book with a name, a phone number and an email. They never set a
password, so the portal does not ask for one:

1. `POST /customer/auth/:companySlug/request-code { email }` emails a 6-digit
   code to the address **the business has on file** for that customer.
2. `POST /customer/auth/:companySlug/verify { email, code }` returns a customer
   access token and sets the refresh cookie.

**Codes:**
- Stored as an HMAC (`customer_login_code`) and valid for 10 minutes.
- Burnt after 5 wrong guesses; a new code voids the previous one.
- At most 5 codes per customer per hour. Any request beyond that silently
  sends nothing.

**No enumeration.** "Send me a code" gives the same answer whether or not the
address belongs to a customer, and whether or not a code went out.

**Rate limits:** request-code 5 a minute, verify 10 a minute, refresh 30 a
minute.

**Identity:**
- The first sign-in creates (or finds) the global `customer_identity` for the
  proven address, marks it email-verified, and links it to the company's
  `company_customer` record.
- The same person at two businesses is one identity with two company records,
  and a separate sign-in at each.
- `customer-identity.repository.ts` is the only code that writes identities.
  It is allowlisted for the platform connection, because the tenant role is
  denied INSERT and UPDATE on `customer_identity`.

**Tokens:**
- `aud: customer`, minted by the existing `TokenService.signCustomerAccess`.
- Each one is bound to one company (`act`) and one customer record (`cc`).
- Staff and platform routes refuse them at the audience check, and customer
  routes (`@Realm('customer')`) refuse staff and platform tokens.

**Sessions:**
- `customer_session` holds refresh tokens, HMAC only, rotated on every use.
- Presenting a rotated token revokes the whole family (`REFRESH_TOKEN_REUSED`).
- The refresh cookie `undarga_crt` is HttpOnly and scoped to
  `/api/v1/customer/auth/<slug>`. A reload restores the session, and two
  businesses' portals in one browser never collide.
- Sign-out revokes the session and deny-lists it at once.

**Revocation:** every request re-reads the customer record. If the business
blocks or deletes the customer, the next call is a 401.

---

## 2. API

| Method | Path | |
|---|---|---|
| `GET` | `/customer/me` | profile and the business's name, timezone and currency |
| `PATCH` | `/customer/me` | `firstName`, `lastName`, `phone`, `locale`. Email is the sign-in address and cannot be changed here (strict body → 400). A phone used by another customer → 409. |
| `GET` | `/customer/appointments?scope=upcoming\|past\|cancelled&limit&offset` | paginated, limit 1–50 |
| `GET` | `/customer/appointments/:id` | details, price and discounts, payment summary, `actions` |
| `POST` | `/customer/appointments/:id/cancel` | `{ reason? }` |
| `GET` | `/customer/appointments/:id/reschedule-options?date=YYYY-MM-DD` | times only |
| `POST` | `/customer/appointments/:id/reschedule` | `{ startsAt }` |
| `GET` | `/customer/payments?limit&offset` | with paid and refunded totals |
| `GET` | `/customer/gift-cards` | |
| `GET` | `/customer/gift-cards/:id/transactions?limit&offset` | the card's holder only |

**What the routes take.** No route accepts a customer or company id. Both come
from the signed token, and every lookup is inside that company (RLS) and keyed
on that customer. Another customer's appointment or card is a **404**,
indistinguishable from one that does not exist.

**What is never returned:**
- the business's notes, tags or loyalty figures;
- internal appointment notes;
- employee ids, job titles or phone numbers (staff appear by their public
  display name, as on the booking page);
- provider references, fees, or who took a payment;
- gift-card codes (only the last four characters).

---

## 3. Cancel and reschedule rules

One function, `customerActions` (`customer-portal.service.ts`), decides. Its
verdict is sent to the UI as `actions` and enforced again on the request. The
deadline is re-checked **under the appointment row lock** inside the existing
Appointment Engine.

| Rule | Refusal `details.reason` |
|---|---|
| Only a PENDING or CONFIRMED booking that has not started | `STATUS` |
| `company_settings.allow_customer_cancel` / `allow_customer_reschedule` | `NOT_ALLOWED_BY_BUSINESS` |
| No online payment in flight for it | `PAYMENT_IN_PROGRESS` |
| Reschedule only: nothing paid yet (the engine does not move payments to the new booking, so the business moves paid bookings) | `ALREADY_PAID` |
| Before `cancellation_window_hours` before the start (branch override first) | `PAST_DEADLINE` (+ `details.deadline`) |

A refusal is `409 CUSTOMER_ACTION_NOT_ALLOWED` with
`details: { action, reason, deadline? }`.

**Reuse of the engine.** Cancelling and rescheduling call the engine's own
`cancel` and `reschedule` through a narrow customer option:
- ownership is checked under the lock;
- the staff detail is not returned;
- a reschedule must be a time **public booking offers** (online-bookable, lead
  time and advance window via the Availability Engine);
- the staff member and room stay the same.

The engine's exclusion constraint and locks still prevent double booking. A
taken time is `409 SLOT_TAKEN` or `SLOT_UNAVAILABLE`.

**Refunds.** Cancelling a paid booking does not refund it. The portal says the
business handles refunds.

---

## 4. Gift cards

The **holder** is the recipient, or the buyer of a card issued to nobody else.
The holder sees the balance, the expiry and the history. A card bought **for
someone else** shows that it was bought, its value and the recipient's name —
not the recipient's balance or spending.

---

## 5. Web

`apps/web/features/customer-portal`, with its own session
(`services/customer-api-client.ts`): separate from the staff client and the
operator console. The access token is held in memory only; a 401 refreshes
once and retries.

| Page | |
|---|---|
| `/portal/:slug` | Overview: next appointments, gift card balances, recent payments, "Book an appointment" |
| `/portal/:slug/appointments` | Upcoming, past and cancelled tabs, paginated |
| `/portal/:slug/appointments/:id` | Details, price, discounts, payments. Reschedule (date → offered times → confirm) and Cancel (reason → confirm) appear only when the server's `actions` allow them; otherwise the server's reason is shown. |
| `/portal/:slug/profile` | Name and phone; email read-only |
| `/portal/:slug/gift-cards` | Balances, expiry, expandable history |

---

## 6. Not done

- **Email delivery.** `MailerService` has no SMTP transport yet (as for
  account emails): development logs the code and production cannot send it.
  A transport is required before the portal is usable in production.
- **SMS sign-in.** Customers who booked with a phone number only cannot sign
  in yet.
- **Payments.** Paying from the portal and requesting a refund are not
  included. Paying online is offered on the booking confirmation; refunds are
  the business's.
- **Promotions.** Only those applied to the customer's appointments are shown.
  Offers targeted at the customer are not listed.
