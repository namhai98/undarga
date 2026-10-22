# SaaS subscriptions and company billing

What a company pays the platform for — not what customers pay a company (that
is `docs/BILLING.md`). No payment provider is integrated: invoices are issued
and settled outside the app, and the seams for a provider are named below.

## Plans live in the database

`plan`, `feature` and `plan_entitlement` hold the catalog. `pnpm db:seed` writes
it from `apps/api/src/subscriptions/plan-catalog.ts` (idempotent; re-run after
editing). **No code reads limits from that file** — every check reads the
database, overlaid by any unexpired `subscription_entitlement_override` for the
company, so plans change without a deploy.

| Plan | Price / month | Branches | Employees | Services | Resources | Customers | Appts / month | Gift cards | Promotions | Online booking | Multi-branch |
|---|---|---|---|---|---|---|---|---|---|---|---|
| FREE | 0 | 1 | 2 | 10 | 2 | 100 | 100 | – | – | ✓ | – |
| STARTER | ₮49,000 | 1 | 5 | 30 | 5 | 1,000 | 500 | – | ✓ | ✓ | – |
| PRO | ₮99,000 | 3 | 15 | 100 | 20 | 5,000 | 2,000 | ✓ | ✓ | ✓ | ✓ |
| BUSINESS | ₮199,000 | ∞ | ∞ | ∞ | ∞ | ∞ | ∞ | ✓ | ✓ | ✓ | ✓ |

Paid plans have a 14-day trial. A limit row with `limit_int = NULL` is
unlimited; a missing row is 0 (fails closed).

## Lifecycle

```
TRIAL ──change plan──▶ ACTIVE ──period ends──▶ ACTIVE (next period, OPEN invoice)
  │                      │  └─invoice unpaid past due──▶ PAST_DUE ──grace (7 d)──▶ EXPIRED
  │                      └─cancel──▶ CANCELLED ──period ends──▶ EXPIRED
  └─trial ends──────────────────────────────────────────────────────────▶ EXPIRED
EXPIRED ──reactivate / change plan / operator extend / invoice paid──▶ ACTIVE
```

- **Effective status** (`subscription-state.ts`) is computed from the stored
  status and its timestamps, so a trial that ended a second ago is over even
  before the sweep writes it down. Every access decision uses it.
- **The sweep** (`SubscriptionLifecycleService`, hourly via
  `SUBSCRIPTION_SWEEP_INTERVAL_MS`, or `POST /platform/subscriptions/sweep`)
  writes transitions down, renews periods and issues renewal invoices.
- **EXPIRED deletes nothing.** The company becomes read-only: every
  `@RequiresWrite` route returns `402 TENANT_READ_ONLY` with
  `reason: SUBSCRIPTION_EXPIRED`; reads work; every plan feature is off; the
  public booking page is down. The subscription endpoints are not
  `@RequiresWrite`, so the company can always renew. The web app shows a
  read-only banner.
- **Plan change** takes effect now, starts a new period and issues an OPEN
  invoice (none for FREE); unpaid invoices for the replaced plan are VOIDed. No
  proration yet. A downgrade below current usage is refused with
  `403 PLAN_LIMIT_EXCEEDED` listing each violated limit.
- **Provisioning** starts a trial of `planKey` (default PRO) for every new
  company. A company with **no** subscription row (provisioned before this
  existed) is unrestricted until it starts a trial or picks a plan.

## Enforcement — one service

`EntitlementsService` is the only thing that answers "may this company…?":

- **Features:** `@RequireFeature('GIFT_CARDS')` on a controller; `FeatureGuard`
  (APP_GUARD after PermissionGuard) checks it → `403 FEATURE_NOT_AVAILABLE`.
  Applied to gift cards and promotions; promotion codes at booking and the
  public booking page (`ONLINE_BOOKING`) check the same service.
- **Limits:** `assertCanAdd(tx, companyId, 'EMPLOYEE')` inside the creating
  service's transaction, under a per-(company, limit) advisory lock, so
  concurrent creates cannot overshoot → `403 PLAN_LIMIT_EXCEEDED` with
  `{ limit, max, current, planKey }`. Wired into branch, employee, service,
  customer (staff and public booking) and appointment creation. A second
  branch also needs `MULTI_BRANCH`. Appointments count those created this
  calendar month (UTC), excluding released holds and the new half of a
  reschedule. There is no resource-creation endpoint yet; resources are counted
  for usage only.
- **Caching:** entitlements 30 s and usage 60 s per company, in process,
  invalidated on every subscription change and (usage) on every allowed create.

## API

| Method | Path | Permission |
|---|---|---|
| `GET` | `/companies/:id/subscription` | `settings:billing:read` |
| `POST` | `/companies/:id/subscription/start-trial` · `/change-plan` · `/cancel` · `/reactivate` | `settings:billing:write` (owner) |
| `GET` | `/companies/:id/billing` · `/billing/:invoiceId` | `settings:billing:read` |
| `POST` | `/platform/companies/:id/subscription/extend` | `platform:billing:manage` |
| `POST` | `/platform/companies/:id/billing/:invoiceId/mark-paid` | `platform:billing:manage` |
| `POST` | `/platform/subscriptions/sweep` | `platform:billing:manage` |

## Paying online

Connected in [PAYMENTS.md](./PAYMENTS.md):

| Method | Path | Permission |
|---|---|---|
| `POST` | `/companies/:id/billing/:invoiceId/pay` | `settings:billing:write` (not `@RequiresWrite`: an expired company can pay to recover) |
| `GET` | `/payments/:transactionId` | `settings:billing:read` for an invoice payment |
| `POST` | `/platform/payments/:transactionId/refund` | `platform:billing:manage` |

- **Renewals**: the sweep issues the OPEN renewal invoice as before; the owner
  pays it from the subscription page.
- **Success**: the provider's confirmation runs `settleInvoicePayment` — the same
  code operator `mark-paid` uses — in the payment's transaction: invoice PAID,
  `subscription_payment` (method ONLINE), and a PAST_DUE / EXPIRED subscription
  is ACTIVE again.
- **Failure**: the invoice stays OPEN and `attempt_count` goes up; the
  subscription moves only as the sweep says (PAST_DUE after the due date, then
  EXPIRED after grace).
- **Cancellation** of the subscription is unchanged. An unpaid checkout can be
  cancelled; money that still arrives is recorded.
- **Refunds** of SaaS payments are platform-only and whole-payment; the invoice
  stays PAID and the subscription is not changed.
- `GRACE` and `SUSPENDED` statuses remain reserved for a provider-managed
  dunning flow, which QPay does not have.
