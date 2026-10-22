# Calendar Integration

Employees connect their own Google Calendar or Microsoft Outlook calendar.
Their appointments are then written to that calendar automatically. If they
choose, the calendar's busy times also stop customers booking them at those
times.

It reuses the existing appointment flow, availability engine and encryption.
There is no second booking system.

## 1. Direction: one-way

| From | To | What |
|---|---|---|
| Undarga | calendar | One event per appointment for that employee: created, updated, deleted |
| calendar | Undarga | Busy **periods only** (start and end), used as unavailability |
| calendar | Undarga | **Nothing else.** Moving or deleting an event in the calendar never changes an appointment |

If someone deletes an event by hand, it is put back on the next sync. An
appointment is changed only in Undarga.

## 2. Providers

| Provider | Status | Scopes requested |
|---|---|---|
| Google Calendar | Implemented and tested end to end against a fake Google | `openid email calendar.events calendar.calendarlist.readonly` |
| Microsoft Outlook (Graph) | Implemented, with unit tests on request shapes | `openid email offline_access Calendars.ReadWrite` |

- **Not requested:** the full `calendar` scope, contacts, or mail.
- **Provider requests** use plain `fetch` with a 15-second timeout. The
  adapters are in `apps/api/src/calendar/providers/`.
- **Adding a provider** means implementing `CalendarProvider` (OAuth,
  calendars, create, update and delete events, busy periods) and registering
  it in `CalendarProviderRegistry`.

A provider is only offered when its OAuth client id and secret are both
configured. `SECRETS_ENCRYPTION_KEY` and a redirect URL are also required.
Without them the provider shows as "not set up" and connecting it returns
`503 CALENDAR_PROVIDER_UNAVAILABLE`. Nothing pretends to be connected.

## 3. Connecting (OAuth 2.0, authorization code + PKCE)

1. **Start.** `POST /companies/:id/calendar-connections/oauth/start` with
   `{provider, employeeId}`.
   - The server creates a random `state` and a PKCE verifier.
   - It stores only SHA-256(state), with the verifier encrypted, the employee,
     and the user who started it. This record lasts 10 minutes and works once.
   - It returns the provider's consent URL.
2. **Consent.** The browser goes to the provider and returns to the
   **configured** redirect URL (`/calendar/callback` in the web app). The
   redirect URL never comes from the request.
3. **Callback.** The callback page posts `{state, code}` to `…/oauth/callback`.
   The server accepts the state only if:
   - it exists, has not expired and has not been used;
   - it is in the same company;
   - it comes from the same user who started it.

   Any other case returns `400 CALENDAR_OAUTH_INVALID`, with one message for
   every reason. The state is used up before the code is exchanged.
4. **Exchange.** The code is exchanged with the verifier. The connection is
   refused if there is no refresh token or the calendar scope was unticked.
5. **Store.** Tokens are sealed with AES-256-GCM (`SECRETS_ENCRYPTION_KEY`),
   bound to the company and employee.
   - Tokens are never returned by any endpoint, and never logged or audited.
   - The employee's upcoming appointments are queued so they appear in the
     calendar.

**Reauthorising** runs the same flow for the same employee and updates the
existing connection. Switching provider requires disconnecting first.

## 4. Who may do what

| Permission | Allows |
|---|---|
| `schedule:read` | Open the page. Only shows employees you may manage |
| `schedule:write:any` | Connect, configure, sync or disconnect **any** employee's calendar (owner, admin, branch manager) |
| `schedule:write:own` | The same, for **your own** staff profile only (employees whose login is linked to them) |

- Read-only, receptionist and employee roles cannot see anyone else's
  connection.
- Platform operators have no access: these are personal accounts.
- Another company's ids return 404.

## 5. Synchronisation

```
appointment created / status change / reschedule ─(same transaction)→ calendar_sync_job
CalendarSchedulerService (every CALENDAR_SYNC_INTERVAL_MS) → CalendarSyncService → provider
```

- **Off the request path.** A booking writes one `calendar_sync_job` row in
  its own transaction. It never calls a provider, so a calendar outage cannot
  block a booking. Companies with no connections write nothing.
- **Reconcile, don't replay.** The worker reads the appointment as it is now
  and makes each connected calendar match:
  - **Pending, confirmed, checked in or in progress:** the event exists with
    current details.
  - **Completed:** kept if the connection's "keep completed appointments"
    setting is on (it is by default), otherwise deleted.
  - **Cancelled, no-show, expired, deleted, reassigned to someone else, or on
    a calendar that was switched:** the event is deleted.
  - **Rescheduled:** the old appointment's event goes and the new one's
    appears.
- **No duplicates.**
  - There is one job row per appointment. A change while a job is queued or
    running increases its `version`, and the worker runs it again afterwards.
  - Jobs are claimed with a conditional update, so two workers never sync the
    same appointment.
  - Events are created with a deterministic id (Google's event `id`,
    Graph's `transactionId`). A retried create therefore adopts the existing
    event instead of making a second one.
- **Stored links.** `calendar_event_link` keeps the external event id per
  connection and appointment, so updates and deletions find the event. A hash
  of the content skips calls when nothing changed.
- **Retries.** Rate limits and provider outages back off for 1 min, 5 min,
  15 min, then 1 hour, and the job is marked `FAILED` after 5 attempts.
  Errors are recorded on the link and the connection. **Sync now**
  (`POST …/:connectionId/sync`) queues everything again.
- **Expired access.** Tokens are refreshed shortly before they expire, and once
  more after a 401. If the refresh is refused (`invalid_grant`), the
  connection becomes `NEEDS_REAUTH`. It is then not retried, and the page asks
  for **Reconnect**.

**Event content** is the service, the branch (name and address), the time,
the booking number and the status. It never includes the customer's name,
phone, email or notes. Events are marked private, and the time zone is the
branch's.

## 6. Busy times and availability

- **What is read.** Every `CALENDAR_BUSY_REFRESH_MINUTES` (10 by default), for
  connections with "use busy times" on, the worker reads events from the
  chosen calendar from one day back to 60 days ahead.
  - Only start, end and busy/free flags are requested. Titles, descriptions
    and attendees are never fetched.
  - Free ("show as available"), cancelled, declined and our own events are
    skipped. **Private events count as busy**, and their details stay unknown.
- **Time zones.** All-day events are converted to start at midnight in the
  calendar's own time zone. Timed events are exact instants. Microsoft is
  queried in UTC.
- **Storage.** The periods are stored in `calendar_busy_block`. Each refresh
  replaces them in one transaction.
- **Effect on bookings.** `AvailabilityRepository` adds these blocks to the
  employee's approved time off.
  - This affects the availability endpoint, public booking and the
    revalidation inside appointment creation. The engine itself is unchanged.
  - Blocks are only used while the connection is `ACTIVE` and opted in. A
    calendar that needs reconnecting is not trusted.
- **Not the only protection.** Bookings, the appointment engine's checks and
  the database exclusion constraint still prevent double booking on their own.
  Busy periods add to that and never replace it. A busy period created
  between refreshes shows up on the next refresh.

## 7. Disconnecting

`DELETE …/:connectionId` does three things:

1. Removes this SaaS's **upcoming** events from the calendar (up to 100, best
   effort).
2. Revokes the grant at Google. Microsoft has no per-grant revoke, so users
   remove the app at https://myapps.microsoft.com.
3. Deletes the stored tokens, event links and busy blocks.

The local deletion happens whatever the provider answers.

## 8. API

All endpoints are under `/api/v1/companies/:companyId/calendar-connections`.

| Method and path | What |
|---|---|
| `GET /` | Providers (configured or not), sync direction, and the employees you may manage with their connection |
| `POST /oauth/start` | `{provider, employeeId}` → `{authorizationUrl, expiresAt}` |
| `POST /oauth/callback` | `{state, code}` → connection and sync status |
| `GET /:id/calendars` | Calendars the account may write to |
| `PATCH /:id` | `{calendarId?, syncCompleted?, useForAvailability?}`. The calendar must be one of the account's own |
| `GET /:id/sync` | Queue counts, last sync, recent errors |
| `POST /:id/sync` | Sync now (manual retry) |
| `DELETE /:id` | Disconnect |

Error codes: `CALENDAR_PROVIDER_UNAVAILABLE` (503), `CALENDAR_OAUTH_INVALID`
(400) and `CALENDAR_PROVIDER_ERROR` (502). "Needs reconnecting" returns
`CONFLICT` (409).

## 9. Configuration

| Variable | Notes |
|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET` | Both or neither |
| `MICROSOFT_CALENDAR_CLIENT_ID`, `MICROSOFT_CALENDAR_CLIENT_SECRET` | Both or neither |
| `MICROSOFT_CALENDAR_TENANT` | `common` (default), `organizations`, `consumers`, or a tenant id |
| `CALENDAR_OAUTH_REDIRECT_URL` | Default `WEB_APP_URL` + `/calendar/callback`. Register it **exactly** with each provider |
| `SECRETS_ENCRYPTION_KEY` | Required to store tokens (shared with notification providers). Changing it makes stored tokens unreadable, and connections become `NEEDS_REAUTH` |
| `CALENDAR_SYNC_ENABLED`, `CALENDAR_SYNC_INTERVAL_MS`, `CALENDAR_BUSY_REFRESH_MINUTES` | Worker settings. The worker is always off in tests |

### Google setup

1. In Google Cloud Console, create a project and enable the **Google Calendar
   API**.
2. Set up the **OAuth consent screen**. Add the scopes
   `.../auth/calendar.events` and `.../auth/calendar.calendarlist.readonly`.
   These are sensitive scopes, so Google verification is needed before
   external users beyond your test users can connect.
3. Under **Credentials**, create an OAuth client ID of type *Web
   application*, and add the redirect URL from `CALENDAR_OAUTH_REDIRECT_URL`
   under *Authorized redirect URIs*.
4. Put the client id and secret into the two `GOOGLE_CALENDAR_*` variables.

### Microsoft setup

1. In Microsoft Entra admin center, go to **App registrations**, choose *New
   registration*, and pick the supported account types that match
   `MICROSOFT_CALENDAR_TENANT`.
2. Under **Authentication**, add the *Web* platform with the redirect URL.
3. Under **Certificates & secrets**, create a client secret.
4. Under **API permissions**, add the Microsoft Graph delegated permissions
   `Calendars.ReadWrite`, `offline_access`, `openid` and `email`.
5. Put the application (client) id and the secret into the
   `MICROSOFT_CALENDAR_*` variables.

## 10. Tests

All tests mock the providers: none reaches a network.

- **Unit tests** (`src/calendar/calendar.spec.ts`):
  - both adapters' request shapes, scopes and PKCE parameters;
  - adopting an existing event on 409, and the deterministic id;
  - busy-period parsing: free, declined, cancelled and our own events
    skipped, and all-day events in the calendar's time zone;
  - error mapping and ID-token parsing;
  - event content, which must never contain customer data;
  - which statuses belong on the calendar.
- **End to end** (`test/calendar.e2e-spec.ts`), using the real Google adapter
  against a fake Google behind a mocked `fetch`:
  - OAuth state checks (unknown, reused, expired, another user, another
    company);
  - PKCE verifier and redirect URI;
  - encrypted tokens that appear in no response or audit entry;
  - background create, reschedule, cancel and completed handling;
  - duplicate jobs and concurrent workers;
  - adopting a create whose answer was lost;
  - throttling and outages, backoff, `FAILED`, and manual retry;
  - token refresh, revoked grants (`NEEDS_REAUTH`) and reconnecting;
  - choosing a calendar, and disconnecting;
  - busy periods blocking availability and booking, honouring the calendar's
    time zone, ignored when switched off or when the calendar needs
    reconnecting, and not counting our own events;
  - per-employee RBAC and cross-company isolation.
- **Web** (`features/calendar/ui/calendar.test.tsx`): the page states, the
  OAuth redirect, options, sync, disconnect confirmation, and the callback
  page's single post and error states.

## 11. What still needs setting up

- OAuth clients at Google and Microsoft, plus Google's verification of the
  sensitive scopes for production use.
- `SECRETS_ENCRYPTION_KEY`, and a public `CALENDAR_OAUTH_REDIRECT_URL`
  registered with each provider.
- A first live connection per provider. Neither provider has been exercised
  against its real service yet; Microsoft has only been tested at the
  request-shape level.
