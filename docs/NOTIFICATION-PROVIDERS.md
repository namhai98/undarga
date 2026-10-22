# Notification Providers

Real email and SMS delivery for the existing notification pipeline. The queue
(outbox → dispatcher → notification rows → worker), the templates and the
settings are unchanged; this adds who actually sends, and how the system
learns what happened to a message.

```
outbox_event ─→ dispatcher ─→ notification ─→ worker ─┬─→ company's own account (if enabled)
                                                     └─→ platform provider (environment)
                                                               │
              provider receipts (signed webhooks) ←────────────┘
```

## 1. Adapters

| Channel | Provider | Send | Delivery receipts | Credentials check |
|---|---|---|---|---|
| Email | **SendGrid** v3 Mail Send | `POST /v3/mail/send`, 202 = accepted | Signed Event Webhook (ECDSA P-256) | `GET /v3/scopes` must include `mail.send` |
| SMS | **Twilio** Programmable Messaging | `POST /Accounts/:sid/Messages.json`, 201 = accepted | `StatusCallback` per message (HMAC-SHA1 `X-Twilio-Signature`) | `GET /Accounts/:sid.json` |
| Push | — | not available | — | — |

Push is not implemented: the app has no device registration, so there is no
token to send to. `PUSH_PROVIDER` accepts only `none` (default) or `mock`
(tests). No push rows are created.

Development and tests:

- `log`: writes the message to the API log, recorded as provider `log`.
  The default outside production.
- `mock`: in-memory test double (`EmailNotificationProvider` etc.). Tests can
  make it fail, time out (UNKNOWN) or confirm delivery.

Both are refused at boot when `NODE_ENV=production`.

All adapters live in `apps/api/src/notifications/providers/`. Each one has a
15-second timeout and no SDK dependency (plain `fetch`).

## 2. What a status means

A notification is only marked as far as the provider actually confirmed.

| Status | Meaning | Set by |
|---|---|---|
| `PENDING` / `RETRYING` | Queued, or waiting for the next attempt | dispatcher / worker |
| `SENDING` | Claimed by a worker, provider call in progress | worker |
| `SENT` | **Accepted** by the provider. Not proof of delivery. | worker (SendGrid 202, Twilio 201) or receipt (`processed`, `queued`, `sent`) |
| `DELIVERED` | The provider **confirmed** delivery | receipt only (SendGrid `delivered`, Twilio `delivered`/`read`) |
| `FAILED` | Refused, bounced, undeliverable, or retry budget spent | worker or receipt (`bounce`, `dropped`, `blocked`, `undelivered`, `failed`) |
| `UNKNOWN` | The provider never answered (timeout). It may have been sent. | worker |
| `CANCELLED` | Never attempted: the address is invalid | dispatcher |

`providerStatus` keeps the provider's own word (`accepted`, `delivered`,
`bounce`…), and `providerEventAt` keeps the time of the latest receipt.

**Retries.** 429 and 5xx responses, and network errors, are retried with a
backoff of 1 min, 5 min and 30 min, up to 3 times. Other 4xx responses, and
Twilio codes 21211/21408/21610/21612/21614, fail at once.

**UNKNOWN is never retried automatically**, because retrying could send the
message twice. A person with `settings:write` can retry it, and can also retry
a `FAILED` message: `POST /companies/:id/notifications/:nid/retry`. The retry
reuses the same row and is audited.

**Receipts only move a message forward.** `DELIVERED`, `FAILED` and
`CANCELLED` are final. A replayed or late receipt (for example `processed`
arriving after `delivered`) changes nothing. Every update checks the status the
row was read in, so two receipts cannot race.

## 3. Platform configuration (environment)

| Variable | Needed for | Notes |
|---|---|---|
| `EMAIL_PROVIDER` | always | `none` \| `log` \| `mock` \| `sendgrid`. Unset: `log` outside production, `none` in production |
| `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` | sendgrid | must be a verified sender or on an authenticated domain |
| `SENDGRID_API_KEY` | sendgrid | needs the **Mail Send** scope (restricted key recommended) |
| `SENDGRID_WEBHOOK_PUBLIC_KEY` | receipts | Signed Event Webhook "Verification Key" (base64 or PEM) |
| `SMS_PROVIDER` | always | `none` \| `log` \| `mock` \| `twilio` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | twilio | |
| `TWILIO_FROM_NUMBER` **or** `TWILIO_MESSAGING_SERVICE_SID` | twilio | E.164 number, or `MG…` |
| `PUSH_PROVIDER` | — | `none` (default) or `mock` |
| `NOTIFICATION_WEBHOOK_BASE_URL` | receipts | the API's public **origin**, with no path, `https://` in production |
| `SECRETS_ENCRYPTION_KEY` | company accounts | 32 random bytes in base64. See §5 |

Boot fails with a clear message if a selected provider is missing its
credentials. Secrets come only from the environment, and none are committed.
`.env.example` lists every variable with an empty value.

Account emails (sign-in codes, verification and reset links) also go through
the platform SendGrid account when `EMAIL_PROVIDER=sendgrid`. They are sent
inline rather than queued, because a code is useless if it arrives late and
must not be stored in a notification row.

## 4. External setup

### SendGrid

1. Authenticate a domain, or verify a single sender, for `EMAIL_FROM_ADDRESS`.
2. Create an API key: **Restricted Access → Mail Send: Full Access**.
3. Optional, for delivery receipts:
   - **Settings → Mail Settings → Event Webhook**: set the Post URL to
     `https://<api>/api/v1/notifications/receipts/sendgrid/platform`.
   - Select the *Processed, Delivered, Deferred, Bounced, Dropped* events.
   - Turn on **Signed Event Webhook** and copy the Verification Key into
     `SENDGRID_WEBHOOK_PUBLIC_KEY`.

   Events older than 10 minutes are refused as replays. Open and click events
   are ignored.

### Twilio

1. Buy a number that can send SMS to your target countries, or create a
   Messaging Service.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` or
   `TWILIO_MESSAGING_SERVICE_SID`.
3. Set `NOTIFICATION_WEBHOOK_BASE_URL` to the API's public origin. Each message
   then carries its own `StatusCallback`
   (`…/notifications/receipts/twilio/platform?n=<id>`), so nothing has to be
   configured in the Twilio console.

   The signature covers the exact URL. A proxy must forward the path and query
   unchanged, and the base URL must not have a path of its own.

## 5. Company accounts

A company can send through its own SendGrid or Twilio account
(**Notifications → Providers** in the app). When its account is enabled, it is
used instead of the platform's for that channel. When the account is disabled
or removed, the platform's account is used again.

| Endpoint | Permission |
|---|---|
| `GET /companies/:id/notification-providers` | `settings:read`. Secrets are masked: only the last four characters are shown (`secretHint`) |
| `PUT /companies/:id/notification-providers/:EMAIL\|SMS` | `settings:write` **and** `settings:billing:write` (the owner, by default) |
| `DELETE /companies/:id/notification-providers/:channel` | same as `PUT` |
| `POST /companies/:id/notification-providers/:channel/verify` | `settings:write`. Calls the provider and records `CONNECTED` or `FAILED` |
| `GET /platform/notification-providers` | `platform:operator:manage`. Provider names and readiness, no secrets |

How credentials are handled:

- **Encrypted at rest.** AES-256-GCM, keyed by `SECRETS_ENCRYPTION_KEY`, with a
  random IV per value.
  - The ciphertext is bound to its company and channel, so a value copied into
    another row fails to decrypt.
  - Without the key, companies cannot save their own accounts. The API returns
    `NOTIFICATION_PROVIDERS_UNAVAILABLE`, and the screen says so.
- **Write-only.** No response, log line or audit entry contains a secret.
  - Audit entries record that a key was replaced, not what it was.
  - Saving without `secrets` keeps the stored one.
- **Rotating the key** makes stored credentials unreadable. Messages for that
  company then fail with "stored provider credentials could not be read", and
  the account is flagged `FAILED`. The company re-enters its secret. There is
  no silent fallback to the platform account.
- **Receipts for company accounts.** The SendGrid Event Webhook URL is shown
  on the Providers screen (`…/receipts/sendgrid/<config id>`), and the company
  stores its own verification key. Twilio receipts need no setup.

## 6. Events, consent and recipients

| Event | Recipient | Category |
|---|---|---|
| `appointment.created` / `confirmed` / `rescheduled` / `cancelled` / `completed` | customer | transactional |
| `appointment.reminder` | customer | reminder |
| `payment.completed` / `payment.failed` | customer | transactional |
| `gift_card.issued` / `assigned` | customer | transactional |
| `subscription.invoice_issued` (renewal) / `subscription.payment_failed` (failed online payment, or past due) | the company's **owner**, or the company's contact details if no owner has joined | billing |

- **Consent.**
  - Reminders are sent by default, but not to a customer whose latest
    `APPOINTMENT_REMINDERS` consent is revoked.
  - Marketing (no such type exists yet) needs a live `MARKETING_EMAIL` or
    `MARKETING_SMS` consent for that channel, and is never sent by push.
  - Transactional and billing messages do not depend on marketing consent.
- **Preferences.** A recipient's `notification_preference` with
  `isEnabled = false` still suppresses messages. The company's customer
  channel switches apply to customer messages, not to billing notices.
- **Language and time.**
  - Templates are chosen in the recipient's locale: an exact match, then the
    same language, then the company's template, then the platform default.
  - Appointment times use the branch's timezone. Billing dates use the
    company's default timezone.
- **Duplicates.** Every event carries a dedupe key, for example
  `payment.failed:<transaction>` or `subscription.past_due:<invoice>`.
  Repeated sweeps and replayed webhooks therefore produce one message.
- **No blocking.** Business requests write one outbox row in their own
  transaction. Provider calls happen only in the background worker.

## 7. Tests

Automated tests never reach a provider: they use the `mock` providers or a
mocked `fetch`.

- **Unit tests** (`src/notifications/providers/providers.spec.ts`,
  `notification-templates.spec.ts`):
  - the SendGrid and Twilio request shapes and outcome mapping (accepted,
    permanent and retryable failures, timeout as UNKNOWN);
  - signature verification, including tampering and replays;
  - encryption: round trip, wrong context, wrong key, tampering;
  - receipt transitions;
  - consent rules;
  - template rendering.
- **End-to-end** (`test/notification-providers.e2e-spec.ts`):
  - accepted vs delivered;
  - UNKNOWN, with no automatic retry, then a manual retry;
  - duplicate events;
  - consent and preferences, recipient locale, billing notices to the owner;
  - company accounts: masking, encryption at rest, validation, verify,
    routing, decrypt failure;
  - signed SendGrid and Twilio receipts, including forged, replayed and
    cross-company attempts;
  - RBAC for configuration and retry;
  - an unconfigured channel creating no rows.
- **Event assertions** in the payment and subscription e2e suites.

## 8. What still needs real credentials

Nothing here has been run against a live provider account. Before going live:

- **SendGrid:** API key, verified from address, and optionally the webhook
  verification key.
- **Twilio:** Account SID, auth token, and a number or Messaging Service.
- **`NOTIFICATION_WEBHOOK_BASE_URL`:** a public `https://` origin for receipts.
- **`SECRETS_ENCRYPTION_KEY`:** needed before companies can connect their own
  accounts.
- **A first live send per channel,** to confirm sender verification and
  country coverage for SMS.
