# Money, Discounts, Notifications and Reporting

Payments, gift cards, promotions, the notification pipeline, the dashboard and
seven reports.

Companion to [CATALOG.md](./CATALOG.md) and [CUSTOMERS.md](./CUSTOMERS.md). This
describes what was **built**, not what was planned.

---

## 0. The premise this was built on

**There is no appointments module.** The schema has `appointment`,
`appointment_item` and the status machine, but no code creates or transitions a
booking. Everything here is built against those tables, so it works the moment a
booking module lands; the tests seed appointments directly.

That means two things in this layer are complete but currently unreachable from
the UI: applying a promotion to a booking, and the four appointment
notification events. Both are exercised by e2e tests. See §10.

---

## 1. Endpoints

| Method | Path | Permission |
|---|---|---|
| `GET` `POST` | `/companies/:id/payments` | `payment:read` / `payment:write` |
| `GET` | `/payments/:paymentId` | `payment:read` |
| `POST` | `/payments/:paymentId/refund` | `payment:refund` |
| `GET` | `/appointments/:id/balance` | `payment:read` |
| `GET` `POST` | `/gift-cards` | `giftcard:read` / `giftcard:issue` |
| `POST` | `/gift-cards/lookup` | `giftcard:read` |
| `GET` | `/gift-cards/:id` · `/balance` · `/transactions` · `/verify` | `giftcard:read` |
| `PATCH` | `/gift-cards/:id` (owner, expiry, recipient — never the balance) | `giftcard:issue` |
| `POST` | `/gift-cards/:id/disable` | `giftcard:issue` |
| `POST` | `/gift-cards/:id/enable` · `/adjust` · `/void` | `giftcard:adjust` |
| `POST` | `/gift-cards/:id/redeem` · `/refund` | `giftcard:redeem` |
| `GET` `POST` | `/promotions` | `promotion:read` / `promotion:write` |
| `POST` | `/promotions/quote` · `/apply` | `promotion:read` |
| `GET` `PATCH` `DELETE` | `/promotions/:id` | `promotion:read` / `promotion:write` |
| `GET` | `/notifications` · `/notifications/:id` · `/stats` | `settings:read` |
| `POST` | `/notifications/run` (this company only) | `settings:write` |
| `GET` `PATCH` | `/notification-settings` | `settings:read` / `settings:write` |
| `GET` `POST` | `/notification-templates` | `settings:read` / `settings:write` |
| `PATCH` | `/notification-templates/:id` | `settings:write` |
| `POST` | `/notification-templates/preview` | `settings:read` |
| `GET` `PATCH` | `/customers/:id/notification-preferences` | `customer:read` / `customer:write` |
| `GET` | `/dashboard` | `report:revenue:read` |
| `GET` | `/reports/revenue` · `/payment-methods` | `report:revenue:read` |
| `GET` | `/reports/appointments` · `/services` · `/employees` · `/customers` · `/cancellations` | `report:read` |

**No new permission keys.** All fifteen already existed. The one distinction
worth naming: `report:read` covers volume and `report:revenue:read` covers
money, because "how busy are we" and "what does this business earn" are
different things to be trusted with. A branch manager is routinely given the
first and not the second.

---

## 2. Four different things the brief called "payment methods"

The brief lists CASH, CARD, BANK, ONLINE, GIFT_CARD, DEPOSIT, PARTIAL and
REFUND as one enum. They are four:

| | Question it answers | Values |
|---|---|---|
| `method` | How did the money move? | CASH · CARD · BANK_TRANSFER · ONLINE · GIFT_CARD · WALLET · OTHER |
| `purpose` | What was it for? | BOOKING · DEPOSIT · BALANCE · NO_SHOW_FEE · TIP · … |
| *partial* | A property of the **amount** | any payment smaller than the balance |
| *refund* | The opposite **direction** | its own table, referencing what it reverses |

A deposit paid in cash is `method: CASH, purpose: DEPOSIT`. Collapsing that into
`method: DEPOSIT` loses the fact that it was cash — and the end-of-day drawer
count is exactly that fact.

Partial payment therefore needs no special endpoint: pay less than the balance
and the appointment becomes `PARTIALLY_PAID`; pay the rest later in a different
method and it becomes `PAID`.

---

## 3. One transaction, or it did not happen

Taking a payment touches four things, and all four are in **one** database
transaction:

1. the `payment` row
2. possibly a gift-card balance and its append-only ledger
3. two `ledger_entry` rows (double entry, plus a third for a gateway fee)
4. the appointment's `paid_minor` and `payment_status`

Any split produces a failure somebody reconciles by hand. A gift card debited
against a payment that rolled back is money the customer simply lost.

The **provider call sits outside** that transaction — validate, then charge,
then write — because holding a database transaction open across a network round
trip is how a connection pool dies the first time a gateway is slow. A crash in
between is recoverable through the idempotency key.

### An ordering constraint the database taught us

The first version backfilled `payment_id` onto the gift-card redemption row
after creating the payment. The append-only trigger in `001_hardening.sql`
refused it — correctly, and for everyone including a superuser. The payment row
now goes **first**, so the ledger row is written with its link already correct.
Atomicity is unchanged: an insufficient balance aborts the whole transaction,
and a test asserts an overspend leaves no payment behind.

### The appointment projection is derived, never accumulated

`paid_minor` is recomputed as the SUM of succeeded payments. An increment is
correct exactly until one write is lost or replayed, and then it is wrong
forever with nothing to compare against. A sum is self-healing.

---

## 4. Provider abstraction

```
PaymentProvider { name, methods, charge(), refund() }
```

A provider **never touches the database**. It is handed an amount and returns an
outcome; the caller writes the row inside its own transaction.

| Provider | Methods | What it is |
|---|---|---|
| `ManualPaymentProvider` | CASH, CARD, BANK_TRANSFER, WALLET, OTHER | Money that already moved. Nothing to authorise, nothing that can decline. |
| `MockOnlinePaymentProvider` | ONLINE | The slot QPay goes into. |

The mock is **deterministic, not random**: an amount whose minor units end in 13
declines, `metadata.simulate: "pending"` stays pending. A mock that fails 10% of
the time at random makes a flaky suite and teaches nobody anything.

`GIFT_CARD` is deliberately not a provider. Redeeming stored value is not a
charge — no money enters the business, a liability the company already owes is
drawn down.

**Adding QPay**: implement the interface, add it to the array in
`payments.module.ts`, remove the mock. The registry refuses to start if two
providers claim `ONLINE`, because silently routing half the payments to a stub
is the failure worth preventing.

---

## 5. Gift cards are a liability, not a discount

The company already took the money. Everything follows from that:

- **The ledger is the truth**; `current_balance_minor` is a cached projection.
  `gift_card_transaction` is append-only by trigger.
- **Every row carries `balance_after_minor`**, which makes the ledger
  self-checking. `GET /gift-cards/:id/verify` replays it and reports agreement
  or the row where it diverges.
- **Overdraw is structurally impossible**: `CHECK (current_balance_minor >= 0)`.
- **Ledger types**: `ISSUE` (+), `REDEEM` (−), `REFUND` (+), `ADJUSTMENT` (±, reason
  required by CHECK), and `VOID` (−, the write-off). Every balance change in
  `GiftCardsService` writes its row in the same transaction as the projection.

### Status

| Status | Meaning |
|---|---|
| `ACTIVE` | Spendable. |
| `EXPIRED` | Derived on read — an `ACTIVE` card past `expires_at`. Never stored. |
| `DISABLED` | Blocked, balance kept, reversible (`/enable`, which needs `giftcard:adjust`). |
| `DEPLETED` | Spent to zero; spendable again if a refund puts value back. |
| `VOID` | Terminal. The balance was written off with a `VOID` row. Cannot be edited, adjusted or disabled. |

### Two ways to spend a card, one set of rules

`POST /gift-cards/:id/redeem` records a redemption on its own; a `GIFT_CARD`
payment redeems inside the payment's transaction. Both call
`GiftCardsService.redeemWithin` — same lock, same checks, same row. Refused
redemptions are `400 GIFT_CARD_NOT_USABLE` with a stable `details.reason`:
`DISABLED`, `VOID`, `EXPIRED`, `NO_BALANCE`, `INSUFFICIENT_BALANCE`,
`CURRENCY_MISMATCH`, `WRONG_BRANCH`, `WRONG_CUSTOMER`.

- **Customer ownership.** A card with an owner can be redeemed against an
  appointment only if the appointment is that customer's. Detaching the owner
  (`PATCH issuedToCustomerId: null`) is the deliberate, audited way round it.
- **Refunds point at a redemption** (`reverses_transaction_id`) and are capped
  at what it took, less earlier refunds. A redemption made by a payment is
  refunded through the payment only, so nothing can be refunded twice.
- **Idempotency.** `redeem` and `refund` take an `idempotencyKey`, unique per
  company and checked after the row lock: a retry returns the first result, and
  a key reused for a different request is 409.

### Concurrency

Two tills, one card, the same second is the case the design is for. The row is
locked with `SELECT … FOR UPDATE` before the balance is read; the CHECK is the
backstop if a refactor drops the lock. A test drives **ten concurrent
redemptions of 30,000 against a 100,000 card** and asserts exactly three
succeed, the balance is 10,000, and a ledger replay agrees.

### Codes

Only an HMAC is stored — the same `TokenHashService` scheme as refresh tokens,
whose own comment anticipated this. The index is **global**, so a lookup cannot
collide with another tenant's card before the `company_id` predicate applies.
The plaintext appears in the issue response and nowhere else; the audit row
records `last4` only, and a test asserts the code never reaches it.

Lookup is a POST with the code in the body, for the same reason a token is: a
code in a URL lands in access logs and the `Referer` header, and unlike a
session it cannot be rotated.

A wrong code, another company's card and an expired card are **indistinguishable
in the response** — anything else is an oracle for guessing codes.

---

## 6. Discounts

One pure function, `discount.calculator.ts`, with no database, clock or
injection — pinned by 20 unit tests.

- Percentages are **basis points**, and the maths is BigInt:
  `discount = subtotal * bps / 10000`.
- BigInt division truncates, rounding the discount **down**. The company never
  gives away more than it advertised, and no rounding artefact can push a total
  below zero.
- The clamp is not defensive programming: a 50,000 voucher against a 30,000
  basket is an ordinary configuration, and without it the negative total flows
  into the payment amount and the revenue report.
- `allocateDiscount` spreads a discount back over the lines with
  largest-remainder, so it **always sums to exactly the discount**. A naive
  `round(share)` drifts, and those minor units live forever as an unexplainable
  gap between the ticket and the ledger.

Quote and apply share one evaluator, so the number on the till screen is the
number that gets charged.

**The usage limit is a conditional UPDATE** —
`SET redeemed_count = redeemed_count + 1 WHERE redeemed_count < max` — and a
zero row count means somebody else took the last one. A test fires five
concurrent applies at a promotion capped at two and asserts exactly two land.
"Limited to the first 100 customers" is a promise with legal weight.

`FREE_SERVICE` exists in the database enum and is **refused** by the DTO: it
cannot be priced without recording which service is free, and the schema has
nowhere to put that.

---

## 7. Notifications

```
business write ─(same tx)→ outbox_event ─→ dispatcher ─→ notification ─→ worker ─→ provider
reminder sweep ───────────→ outbox_event        (NotificationSchedulerService polls all three)
```

Events: `appointment.created / confirmed / rescheduled / cancelled / completed /
reminder`, `gift_card.issued / assigned`, `payment.completed`. The appointment
and gift-card services emit with `emitWithin(tx, …)` inside their own write
transactions — one INSERT, so the request never waits on a provider.

### Why the outbox and not BullMQ

The brief says to use BullMQ "if already available". It is not — only `ioredis`
is installed — and Redis is deliberately **optional** here: `RedisModule`
degrades to a no-op when it cannot connect.

Pushing notification jobs into Redis would quietly make that optional dependency
load-bearing: a payment commits, the enqueue fails, and the receipt is never
sent with nothing recorded. `outbox_event` already exists in the schema for
exactly this, and gives the property that matters — the event is written in the
**same database** as the thing that caused it.

BullMQ remains the natural transport later. It slots in at the **dispatcher**;
nothing above or below changes.

### The worker

`NotificationSchedulerService` polls in-process every
`NOTIFICATION_WORKER_INTERVAL_MS` (default 15 s; off with
`NOTIFICATION_WORKER_ENABLED=false`, and always off in tests). Ticks do not
overlap; several API instances may all run it because every stage claims its
work. `POST /notifications/run` does one pass for the caller's company only.

| Failure | Handling |
|---|---|
| provider says retryable, or throws | `RETRYING`, backoff 1 min / 5 min / 30 min, then `FAILED` after `max_retries` (3) |
| provider says permanent | `FAILED` immediately |
| worker died mid-send | a row stuck in `SENDING` for 10 min is put back, counting as an attempt |
| event cannot be dispatched | `outbox_event.attempts` + 1; `FAILED` after 5 |

### Every stage survives a replay

| Stage | Guard |
|---|---|
| dispatcher | `notification.dedupe_key` is unique per company |
| worker | claims a row with `UPDATE … WHERE status IN ('PENDING','RETRYING')` |

A test forces a published outbox row back to PENDING — exactly what a crashed
dispatcher leaves — reruns, and asserts no second notification.

### Channels and providers

```
NotificationWorkerService → NotificationProviderRegistry → NotificationProvider
                                                             ├── EmailNotificationProvider
                                                             ├── SmsNotificationProvider
                                                             └── PushNotificationProvider
```

All three are mocks (`providers/mock.provider.ts`): they log the whole message
in development and, anywhere else, only the recipient's **domain** / last
digits. Outside production they keep the last 200 messages in memory and can be
told to fail — which is how the tests drive retries. A real vendor is one class
registered after the mock in `NotificationsModule`; the registry is last-wins.
Each provider also owns `isValidAddress`, checked before a row is created. A production log full of customers' phone numbers
is a breach waiting for whoever has log access — `mail/mailer.service.ts`
already made this decision, and the two behave the same way.

### What decides whether a message is created

Per channel, in order: the type goes out on it (company `eventChannels`, else
the default) → the company has the channel on → the customer has not turned it
off (`notification_preference`) → there is an address → the address is valid.
The first four suppress silently (no row). An invalid address becomes a
`CANCELLED` row with `Invalid email address.` / `Invalid phone number.`, so the
history can say why a customer heard nothing. Push has no device registry yet,
so it currently reaches nobody.

Defaults: appointment messages on email, SMS and push; completed, gift-card and
payment messages on email only. A gift-card message never contains the code.

### Templates

Platform defaults live in code (`notification-templates.ts`) for every (type,
channel). A company may save its own in `notification_template`; an active one
is used, an inactive one falls back to the default. Variables: `{{customerName}}`,
`{{serviceName}}`, `{{branchName}}`, `{{employeeName}}`, `{{appointmentDate}}`,
`{{appointmentTime}}`, `{{companyName}}`, plus `{{giftCardBalance}}` and
`{{paymentAmount}}` for those types. Unknown or inapplicable variables, an email
without a subject, a push without a title and an SMS over 480 characters are
refused at save. Values are read from the database at dispatch (booking-time
names from the item snapshot) and times are rendered in the branch's timezone.

### Reminders

A sweep each tick finds live (pending/confirmed) appointments whose
`starts_at − offset` has arrived, for each of the company's
`reminder_offsets_minutes` (default 24 h and 2 h), skipping a reminder whose
moment passed before the booking existed. Each is recorded in
`appointment_reminder`, unique on (appointment, offset, starts_at), in the same
transaction as its outbox event — so racing sweeps produce exactly one. A
cancelled booking stops matching; a rescheduled one is a new row with its own
reminders.

---

## 8. Dashboard and reports

| Endpoint | Permission | What |
|---|---|---|
| `GET /dashboard` | `report:read` | Today: appointments by status, completed, cancelled, no-show; upcoming (7 days); new customers; popular services, promotion use and gift-card activity over `popularWindowDays` (30). Revenue/outstanding only with `report:revenue:read`. |
| `GET /reports/appointments` | `report:read` | Totals by status with rates; by day; by service, employee, branch (paged) |
| `GET /reports/customers` | `report:read` | New by day, active, returning, running total |
| `GET /reports/services` | `report:read` | Most booked (paged, with share), booking trend of the top five |
| `GET /reports/promotions` | `report:read` | Redemptions, customers, discount, usage by promotion (paged), by day |
| `GET /reports/gift-cards` | `report:read` | Issued, active/expired/disabled/void, balances, redemption and refund activity by day |
| `GET /reports/revenue` · `/payment-methods` | `report:revenue:read` | Settled payments net of refunds; by method (unchanged) |

### One filter shape

`from`/`to` (inclusive, at most a year), `branchId`, `employeeId`, `serviceId`,
`status` (comma-separated; HOLD and EXPIRED are never counted), `limit`/`offset`
for breakdown tables. `AnalyticsScopeService` resolves it once:

- **Timezone.** Days are the company's calendar days
  (`company.default_timezone_name`): range bounds and day buckets are both
  computed by PostgreSQL (`AT TIME ZONE`), so they cannot disagree. The
  dashboard's "today" is worked out on the server; the browser no longer sends
  an offset.
- **Tenant.** A branch, employee or service id from another company is 404.
- **Branch scope.** A member confined to some branches (`company_user_branch`)
  sees only those; naming another branch is 404; naming none means "my
  branches". Company-wide gift-card inventory is withheld from them.
- **Money.** Counts need `report:read`. Every amount is `null` without
  `report:revenue:read`, with `amountsVisible: false` (and `restricted` on the
  dashboard) — never a zero that looks like data.
- **Employee / service** filters apply to the appointment's line items
  (`EXISTS` for appointment-level figures, directly for item-level breakdowns).

### Performance

Every figure is a `GROUP BY` / `COUNT` / `SUM` in PostgreSQL; names are joined
in the same statement (no per-row lookups); series are zero-filled in memory
from at most 366 days. New indexes (migration `20260930090000_report_indexes`):
`appointment(company_id, starts_at)`, `company_customer(company_id, created_at)`,
`promotion_redemption(company_id, redeemed_at)`,
`gift_card_transaction(company_id, type, occurred_at)`,
`gift_card(company_id, issued_at)`. No server-side cache: figures must move the
moment a booking does; the browser holds a dashboard for 30 s and a report for 60 s.

### Definitions

**Revenue means settled payments net of refunds, not appointment totals.**
Booked value (appointment totals of everything not cancelled) is shown
separately and labelled as booked. Rates are **basis points**. "Active
customers" booked something not cancelled in the range; "returning" existed
before it. With appointment filters, "new customers" are those created in the
range who booked in it matching the filters, and the company-wide total is
omitted. No report contains a customer's name or contact details.

---

## 9. Security

| Property | How |
|---|---|
| Tenant isolation | `TenantScopedRepository` + RLS. Cross-tenant → **404**. |
| Payment integrity | One transaction; double-entry ledger; `CHECK (refunded_minor <= amount_minor)`. |
| Gift-card integrity | `FOR UPDATE`; append-only ledger; `CHECK (balance >= 0)`; self-verifying replay. |
| Promotion integrity | Conditional UPDATE for the cap; unique `(company, promotion, appointment)`. |
| Idempotency | Globally unique `payment.idempotency_key`, checked in service **and** enforced by the constraint. |
| RBAC | Taking money, refunding it, issuing a card and adjusting one are four separate permissions. |
| Audit | `payment.created`, `payment.refunded`, `gift_card.issued/updated/disabled/enabled/redeemed/refunded/adjusted/voided`, `promotion.created/updated/applied/archived`. |

No financial rule is enforced only on the client. Every client-side check has a
server check behind it and usually a database constraint behind that.

Six files were added to the ESLint raw-SQL allowlist, each with its reason in
`packages/eslint-config/nest.js`: two cross-tenant claim loops, three row locks
and conditional updates, and the reporting aggregation.

---

## 10. Tests

| Suite | Count | Covers |
|---|---|---|
| `discount.calculator.spec.ts` | 20 | percentages, rounding direction, 2^53, caps, clamping, targeting, allocation summing |
| `billing.e2e-spec.ts` | 51 | payments, partial payment, balance, idempotency (including concurrent), gateway decline, refunds, ledger balance, gift cards, **10 concurrent redemptions**, promotions, **5 concurrent applies against a cap of 2**, isolation, RBAC, audit |
| `giftcards.e2e-spec.ts` | 40 | creation, balance, search by code/last four/customer, expiry, disable/enable, the four ledger types, append-only and non-negative at the database, invalid and over-balance redemption, refund caps, **10 concurrent redemptions**, concurrent idempotent retries, concurrent refunds, disable racing a redemption, customer ownership, cross-tenant, public API, RBAC, audit |
| `notifications.e2e-spec.ts` | 34 | event → outbox job per appointment status change and gift card, queue processing through the mock providers, dedupe under replay, company templates and fallback, retry → success, bounded retries, permanent failure, outbox give-up, reminders at their offsets, **racing reminder sweeps**, late bookings, custom/disabled reminders, cancelled bookings, disabled channels and types, customer opt-out, invalid and missing recipients, template/settings validation, history fields, cross-tenant, public API, RBAC |
| `notification-templates.spec.ts` | 13 | variables, fallbacks, no markup interpretation, every default renders, gift-card defaults never mention a code, effective channels, address validation, simulated failures |
| `reports.e2e-spec.ts` | 26 | exact figures over a fixed week: totals/rates, timezone day buckets, date/branch/employee/service/status filters alone and combined, paging, validation, customers (filtered and not, no names), services and trend, promotions, gift cards, dashboard (and by branch), empty ranges, cross-tenant ids and paths, money hidden without the revenue permission, branch-scoped members, RBAC |
| `analytics.e2e-spec.ts` | 21 | the full notification chain, replay safety, opt-out, dashboard revenue definitions and refunds, money withheld from `report:read`-only roles, revenue and payment-method reports, isolation |
| `gift-card.test.tsx` | 12 | list, server-side search and status filter, issuing to a customer, the detail fields, disable, redemption with a stable idempotency key across a retry, refusal messages, refunds from the ledger, permission-gated actions, the customer page section |
| `notifications.test.tsx` | 10 | history fields and retry state, server-side filters, message detail, settings save, read-only settings, template status, create from default with preview, edit with server validation, customer preferences |
| `analytics.test.tsx` | 12 | dashboard figures, withheld money, branch filter, no request without permission; reports totals/chart/tables, every filter sent, empty and error states, range validation, paging, revenue tab gating, branch-limited gift cards |
| `refund-dialog.test.tsx` | 7 | the cap, the confirmation, minor-unit conversion, the gift-card destination lock, server refusal |

---

## 11. Limitations

- **Nothing is delivered.** The three providers are mocks that record and log.
- **Push reaches nobody** until an app registers device tokens; there is no
  device registry yet.
- **Customer preferences are staff-managed** (on the customer page); there is
  no customer self-service account or unsubscribe link yet.
- **Templates are single-locale.** The `locale` column exists; translations
  are not exposed.
- **No real gateway.** `ONLINE` is the deterministic mock.
- **No gift-card expiry sweep.** Expiry is derived on read, so an expired card
  is correctly refused; no job flips the stored status.
- **No coupon codes.** `Coupon` exists in the schema; promotions are applied by
  id or automatically.
- **Invoices are untouched.** The tables exist; nothing writes them.
- **`report:export` is unused.** Reports are read on screen; there is no
  download, which is what that permission is for.
