# Online payments

How money is taken online through an external provider (QPay first), how a
payment is confirmed, and how it lands in the existing books.

- Backend: `apps/api/src/payments/gateway/`, `payment-transactions.service.ts`,
  `payment-webhooks.service.ts`, `online-payments.controller.ts`.
- Web: `apps/web/features/payments/`.

In-person payments are a different thing: cash, card terminal and bank
transfers that staff record. They are covered in [BILLING.md](./BILLING.md).

---

## 1. Shape

```text
PaymentProvider (gateway/payment-provider.ts)
├── createPayment()   a checkout: QR, bank-app links, or a hosted page
├── getPayment()      the provider's answer, fetched server to server
├── refundPayment()
├── cancelPayment()
└── verifyWebhook()   is this delivery genuine, and which payment is it about

PaymentGateway        the configured provider (PAYMENT_PROVIDER), lookup by stored name
PaymentTransaction    payment_transaction: one online attempt (tenant-scoped, RLS)
PaymentWebhook        payment_webhook_event: every delivery, verified or not (platform-only)
PaymentTransactionsService   start · sync · apply-and-settle · cancel · refund
PaymentWebhooksService       verify → resolve → dedupe → sync
```

**Adding a provider** takes two steps. Business logic does not change.

1. Write a class implementing `PaymentProvider`.
2. Add one case to `paymentGatewayProviders` in `gateway/payment-gateway.ts`.

Transactions always use the provider that took them, never "whatever is
configured now".

### States

| Status | Meaning |
|---|---|
| `PENDING` | Created at the provider; waiting for the payer. |
| `PROCESSING` | In flight at the provider, or paid with a different amount (needs review). |
| `SUCCEEDED` | The provider confirmed it, and it is settled into the books. |
| `FAILED` | The provider says it failed. A new attempt can be started. |
| `CANCELLED` | Abandoned, cancelled, or expired. |
| `REFUNDED` | Fully refunded. A partial refund stays `SUCCEEDED` with `refunded_minor > 0`. |

### What is stored, and what never is

**Stored:** company, customer, initiating user, the appointment or invoice,
provider, provider transaction and payment ids, amount, currency, fee,
status, metadata, and timestamps.

**Checkout data:** `checkout` holds only what the payer needs (QR payload, app
links, hosted-page URL). It is public by nature.

**Never stored:** card numbers, CVV, or any credential. The payer types card
details only on the provider's own page or in their bank app.

---

## 2. Confirmation: nothing the browser says is believed

1. **Start.** `POST /payments` (or the invoice or public equivalent) reserves a
   `PENDING` transaction and asks the provider for a checkout. The UI shows the
   QR, the bank-app links, or the hosted page.
2. **The payer pays at the provider.**
3. **Confirm.** Our server asks the provider what happened, server to server
   (`getPayment`). Two things trigger that question:
   - a verified webhook, or
   - a status read of an open transaction last checked more than 10 seconds
     ago. The UI polls every 3 seconds while a payment is open.
4. **Apply.** Under a row lock, the new state is applied. On `SUCCEEDED`, it
   settles into the existing records **in the same database transaction**:
   - **Appointment:** a `payment` row (method ONLINE, the provider's ids),
     balanced ledger entries including the provider fee, the appointment's
     derived `paid_minor` and `payment_status`, and the `payment.completed`
     receipt event (via `emitWithin`).
   - **Subscription invoice:** `settleInvoicePayment`, the same code as
     operator mark-paid. The invoice becomes PAID, a `subscription_payment` is
     recorded, and a PAST_DUE or EXPIRED subscription becomes ACTIVE again.

No endpoint accepts a status, and the request schemas are strict.

**Amount check.** A paid amount or currency that differs from what was asked
is **not settled**: the transaction stays `PROCESSING` with a review note, and
an audit row is written.

**Late money.** If the provider reports SUCCEEDED for a transaction that was
`CANCELLED` or `FAILED` (the payer had already scanned the QR), it **is**
settled. The money moved.

---

## 3. Duplicates and idempotency

| Guard | Where |
|---|---|
| `idempotencyKey` is **required** on every start; the same key returns the same transaction. Reusing a key for a different payment returns 409. | `UNIQUE (company_id, idempotency_key)` |
| At most **one open** (PENDING/PROCESSING) transaction per appointment and per invoice. A second request, even with another key, gets the open one back. | Partial unique indexes |
| The provider is called with our transaction id as its idempotency key, and a crash mid-start resumes on retry. | `start()` |
| One provider payment settles at most once. | `UNIQUE (provider, provider_payment_id)` |
| Settlement creates a `payment` row whose idempotency key is `ptx:<transaction id>`, which is globally unique. | `payment.idempotency_key` |
| A webhook and a poll for the same payment serialise on a row lock, and every transition checks the state it is leaving. | `applyProviderState()` |
| Two refund clicks cannot both go through: in-flight (PENDING) refunds count against the refundable amount, under the payment row lock. | `refundThroughGateway()` |

---

## 4. Webhooks

```text
POST /api/v1/payments/webhook/:provider    (GET also accepted, for QPay callbacks)
POST /api/v1/payments/webhook              the configured provider
```

The endpoint is public, since a provider has no token. It is rate-limited to
300 requests a minute. Each delivery goes through these steps:

1. **Verify.** The provider checks the signature.
   - **mock:** `x-mock-signature: t=<unix>,v1=<HMAC-SHA256(t.rawBody)>`, with a
     5-minute timestamp tolerance against replays.
   - **QPay:** QPay does not sign its callbacks. Each invoice's `callback_url`
     carries **our** HMAC over the transaction id (`PaymentSigner`).
   - Signatures are checked over the raw request bytes (`rawBody: true` in
     `main.ts`), never re-serialised JSON.
   - **Invalid:** `401 WEBHOOK_SIGNATURE_INVALID`, recorded as `REJECTED`, and
     nothing else happens.
2. **Resolve** which transaction, and so which company, by an id the delivery
   had to sign. This is the one cross-tenant lookup
   (`payment-platform.repository.ts`, allowlisted). The rest runs inside that
   company through `runInCompany()`.
3. **Dedupe** on `(provider, eventKey)`:
   - an event already `PROCESSED` returns `{ duplicate: true }` and does
     nothing;
   - one that changed nothing last time (`IGNORED`) or `FAILED` is tried again.
4. **Sync.** The state is read back from the provider and applied as in §2. The
   body is never trusted for state: a genuinely signed "succeeded" for a
   payment the provider still calls PENDING changes nothing (tested).
   A failure here answers 5xx so the provider retries, and the event row keeps
   the error.

**Recording.** Every delivery is kept in `payment_webhook_event`:

- verified or not, and with which outcome;
- payloads with sensitive-looking keys removed, capped at 8 KB.

**Access.** Operators see deliveries at `GET /platform/payments/webhook-events`.
Tenants cannot read the table at all (RLS deny plus a `REVOKE`).

---

## 5. Refunds

| Payment | Route | Permission |
|---|---|---|
| Appointment (online) | `POST /payments/:id/refund` or the existing `POST /companies/:id/payments/:paymentId/refund` | `payment:refund` |
| Subscription invoice | `POST /platform/payments/:id/refund` | `platform:billing:manage` |

**Through the provider.** A gateway payment is refunded through the provider
that took it:

1. A PENDING refund row is written.
2. The provider is called, with the refund id as its idempotency key.
3. Only on success does the refund post: ledger reversal, payment and
   appointment totals, and the transaction's `refunded_minor` and status.
4. A provider decline is a `502`, the refund is marked FAILED, and nothing is
   recorded as refunded.

**Partial refunds** are allowed where the provider supports them (mock yes,
QPay no: whole payments only).

**Other destinations.** A refund to `GIFT_CARD`, `CASH` or `BANK_TRANSFER` is
still a local record, as before (BILLING.md).

**Refunded outside the system.** If the provider later reports a payment
refunded in its own dashboard, the transaction is flagged for reconciliation.
It is not reversed automatically.

---

## 6. APIs

| Method | Path | Permission |
|---|---|---|
| `POST` | `/payments` | `payment:write` — start for an appointment (`appointmentId`, optional `amountMinor` ≤ owed, `idempotencyKey`) |
| `GET` | `/payments/:id` | `payment:read` (appointment) / `settings:billing:read` (invoice) |
| `POST` | `/payments/:id/refund` | `payment:refund` (appointment payments only) |
| `POST` | `/payments/:id/cancel` | `payment:write` / `settings:billing:write` |
| `POST` | `/companies/:id/billing/:invoiceId/pay` | `settings:billing:write` |
| `POST` | `/public/companies/:slug/payments` | the booking's payment token |
| `GET` | `/public/companies/:slug/payments/:id?token=` | the booking's payment token |
| `POST` | `/payments/webhook[/:provider]` | provider signature |
| `GET` | `/platform/payments` | `platform:billing:manage` |
| `GET` | `/platform/payments/webhook-events` | `platform:billing:manage` |
| `POST` | `/platform/payments/:id/refund` | `platform:billing:manage` (subscription payments) |
| `POST` | `/payments/:id/simulate`, `/public/…/payments/:id/simulate` | development only (`PAYMENT_PROVIDER=mock`) |

**Tenant routes** resolve the company from the token's active company (or
`X-Company-Id`) through TenantGuard. A transaction is only ever looked up
inside that company, so another tenant's id is a 404.

**Operator access** follows the existing permissions:

- `platform:billing:manage` for SaaS payments and the cross-tenant list. That
  list shows amounts and statuses only, never customers.
- Tenant routes allow platform access (`@AllowPlatformAccess`) under the usual
  `platform:company:data:*` rules.

**Errors:**

| Code | Meaning |
|---|---|
| `PAYMENTS_UNAVAILABLE` (503) | No provider configured, or a currency it cannot take |
| `PAYMENT_PROVIDER_ERROR` (502) | The provider failed. Our message only; provider bodies are logged without secrets, never returned. |
| `WEBHOOK_SIGNATURE_INVALID` (401) | The delivery did not verify |

---

## 7. Public booking

**The offer.** The booking confirmation gains `payment`, which is null when
online payment is unavailable:

```json
{ "token": "v1.<payload>.<sig>", "amountMinor": "3500000", "currencyCode": "MNT", "purpose": "BOOKING" }
```

**The amount** is the server's:

- what is still owed; or
- the company's **deposit**, when `company_settings.require_deposit` is set
  with `deposit_percent_bps`, rounded up.

**The token** is a signed, expiring (48 h) capability for that one booking.

- Its payload holds only the appointment number the confirmation already shows.
- The company is bound in through the signature.
- It cannot be used under another company's slug, or to read another booking's
  payment.

**Optional.** Paying is optional: the booking stands either way.

---

## 8. SaaS billing

See [SUBSCRIPTIONS.md → Paying online](./SUBSCRIPTIONS.md#paying-online).

- Renewal invoices are paid the same way.
- A failed attempt increments `attempt_count`.
- The sweep still decides PAST_DUE and EXPIRED.

---

## 9. Providers

### QPay (`PAYMENT_PROVIDER=qpay`): merchant API v2, MNT only

| Call | QPay |
|---|---|
| auth | `POST /v2/auth/token` (Basic client credentials; bearer cached, re-fetched once on 401) |
| createPayment | `POST /v2/invoice` (amount in major units, `sender_invoice_no` = our transaction id, signed `callback_url`) → QR + bank-app links + short URL |
| getPayment | `POST /v2/payment/check` — PAID rows → SUCCEEDED; a FAILED row keeps it PENDING (the QR stays payable) |
| refundPayment | `DELETE /v2/payment/refund/:payment_id` — whole payments only |
| cancelPayment | `DELETE /v2/invoice/:invoice_id` (best effort) |

QPay invoices do not expire on their own. An unpaid checkout is retired after
30 minutes, when the next attempt starts or a status read finds it expired,
and the QPay invoice is cancelled. Money that still arrives is booked.

### Mock (`PAYMENT_PROVIDER=mock`): the local simulator

- Behaves like a hosted gateway: an asynchronous outcome, signed timestamped
  webhooks, and state read back from it.
- Driven by `simulate()`. In the UI, a development-only box offers "Simulate
  payment" and "Simulate decline", which go through the real webhook handler.
- A refund whose amount ends in 13 minor units is declined.
- State is in memory.
- **Refused in production** by env validation.

The older synchronous `mock-online` in-person recorder is no longer registered
in production either.

---

## 10. Configuration

All secrets come from the environment (`.env.example`), validated at boot:

| Variable | |
|---|---|
| `PAYMENT_PROVIDER` | `none` (default) · `mock` · `qpay` |
| `PAYMENT_SIGNING_SECRET` | ≥ 32 random chars. Signs webhook URLs, mock webhooks, booking payment links. Rotating it invalidates outstanding payment links. |
| `PAYMENT_WEBHOOK_BASE_URL` | This API's public origin; `https://` in production |
| `QPAY_BASE_URL` | `https://merchant.qpay.mn` (sandbox: `https://merchant-sandbox.qpay.mn`) |
| `QPAY_CLIENT_ID`, `QPAY_CLIENT_SECRET`, `QPAY_INVOICE_CODE` | Issued by QPay with the merchant account |

**Boot checks.** Startup fails when:

- a provider is chosen without its secrets;
- `mock` is selected in production;
- the webhook URL is not `https://` in production.

---

## 11. Not done

- **Refunds that settle later.** A refund the provider accepts as PENDING
  stays PENDING; nothing reconciles it later yet.
- **External refunds.** Refunds made in the provider's dashboard are flagged,
  not booked.
- **Reconciliation job.** There is no scheduled job that re-checks open
  transactions. Polling and webhooks cover the live cases.
- **Stale checkouts on voided invoices.** An open checkout on an invoice that
  a plan change voids is not cancelled automatically. If it is paid, the money
  is recorded and flagged ("paid after the invoice had closed").
- **Merchant of record.** Every company's payments go to the platform's single
  merchant account. Per-company merchant accounts (marketplace payouts) are a
  later decision.
