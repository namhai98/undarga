# Advanced booking

Recurring appointments, booking rules, employee time off, resource
availability and per-service concurrency caps. All of it runs through the
existing appointment engine and availability engine — there is no second
availability engine, and the pure engine (`availability.engine.ts`) is
unchanged. New constraints enter it as busy time or as a filter on its slots.

## Booking rules

One resolver, `apps/api/src/booking-rules/booking-rules.ts`, decides every
rule. Precedence:

    service override  →  branch override  →  company setting  →  default

| Rule | Company field | Default | Where it applies |
| --- | --- | --- | --- |
| Minimum notice | `minimumBookingNoticeMinutes` | 60 min | availability, staff and public booking, reschedule, series |
| Booking window | `maximumAdvanceBookingDays` | 90 days | same |
| Cancellation deadline | `cancellationDeadlineHours` | 24 h | staff cancel, series cancel, customer portal |
| Rescheduling allowed | `reschedulingAllowed` | yes | staff and customer reschedule |
| Rescheduling deadline | `rescheduleDeadlineHours` | = cancellation deadline | staff and customer reschedule |
| Customer self-service | `allowCustomerCancel`, `allowCustomerReschedule` | yes | customer portal |
| Max at the same time | service `maxConcurrentBookings` only | none | availability and booking |

API: `GET/PATCH /api/v1/companies/:companyId/booking-settings`
(`settings:read` / `settings:write`). Service overrides are fields on the
service (`bookingLeadTimeMin`, `maxAdvanceBookingDays`,
`cancellationWindowHours`, `maxConcurrentBookings`; `null` = inherit).

The server checks every rule on every path; the web screens only explain
them. A refused booking answers `409 SLOT_UNAVAILABLE` with
`details.reason` (`MINIMUM_NOTICE`, `BEYOND_BOOKING_WINDOW`,
`EMPLOYEE_TIME_OFF`, `RESOURCE_UNAVAILABLE`, `MAX_CONCURRENT_BOOKINGS`, …).

### Late cancellations and changes

Past a deadline, staff get `422 BOOKING_RULE_VIOLATION` (`details.rule` is
`CANCELLATION_DEADLINE`, `RESCHEDULE_DEADLINE` or `RESCHEDULING_DISABLED`).
They may go ahead only by sending `lateCancellation: true` / `lateChange: true`,
which needs `appointment:cancel:any`; the history records "(late
cancellation)" / "(late change)". The deadline is re-checked under the row
lock. Customers in the portal cannot override a deadline. When rescheduling
is switched off, nobody can move an appointment.

## Recurring appointments

    POST /appointments/recurring/preview   check every date, create nothing
    POST /appointments/recurring           create the series
    GET  /appointment-series/:id           the rule and every occurrence
    POST /appointment-series/:id/cancel    { scope: 'occurrence' | 'future' }

Rules: `DAILY`, `WEEKLY` (optionally on chosen weekdays, 0 = Sunday) or
`MONTHLY` (the same day of the month), every 1–12 units, ending on a date
or after a count. At most 52 occurrences.

- The wall-clock time recurs: 10:00 stays 10:00 across a daylight-saving
  change. Each instant is computed from its own local date.
- A monthly rule on the 31st skips months without one and reports them in
  `skippedDates`; it never moves to another day.
- Every occurrence is checked exactly like a single booking: rules,
  business hours, schedules, time off, resources, existing bookings, cap.
- With `onConflict: 'fail'` (default) any date that cannot be booked
  refuses the whole series with `409 SERIES_CONFLICT` and the dates listed.
  `'skip'` books the free dates and reports the rest. A conflicting
  appointment is never created.
- All occurrences are written in one transaction, each under the usual
  advisory locks and exclusion constraint. If a date is taken between the
  check and the write, nothing is created.
- Each occurrence is an ordinary appointment (`seriesId`, `seriesIndex`), so
  it can be moved or cancelled on its own. One notification is sent for the
  whole series; each visit still gets its own reminder.
- Cancelling `future` needs `appointment:cancel:any` and runs in one
  transaction. The series becomes `CANCELLED` when nothing is left, or
  `ENDED` when its last visit is over.

## Employee time off

    GET/POST /time-off       PATCH/DELETE /time-off/:id

Types: vacation, sick, personal, unpaid, training, public holiday, other.

- `timeoff:approve` (managers): record anyone's time off as `APPROVED`;
  approve or reject requests.
- `timeoff:request` (staff): request your own (omit `employeeId`); it stays
  `PENDING` and blocks nothing until approved. You only see your own.
- Approved time off is removed from availability right away. Over booked
  appointments it is refused (`409 TIME_OFF_CONFLICT`, appointments listed)
  unless `allowConflicts: true`. Appointments are never cancelled
  automatically.
- DELETE cancels it and keeps the record.

## Resources

    GET/POST /resource-types, PATCH /resource-types/:id
    GET/POST /resources, GET/PATCH/DELETE /resources/:id
    GET/PUT  /resources/:id/availability            weekly windows (HH:MM)
    GET/POST /resources/:id/unavailability, DELETE …/:unavailabilityId

`resource:read` / `resource:write`.

- A resource is exclusive: one booking at a time (database exclusion
  constraint). Capacity means several resources of one type; a service that
  needs "a treatment room" takes any free one.
- Weekly windows narrow a resource to part of the branch's hours; none means
  it follows the branch's hours.
- Unavailable periods (maintenance, out of service…) block it entirely.
  Adding one over booked appointments is refused with them listed, unless
  `allowConflicts: true`.
- Appointments check both employee and resource availability.

## Maximum simultaneous bookings

`service.maxConcurrentBookings` caps overlapping appointments of a service at
a branch across all staff (limited equipment, a capped consultation). It
filters availability and is enforced at booking under an advisory lock per
(branch, service), so two racing bookings cannot both pass.

Group classes (many customers in one appointment, `service.capacity > 1`)
remain out of scope by design (see docs/DATABASE.md).

## Security

- Every query carries the resolved company; another company's ids match
  nothing (404).
- Existing RBAC: `appointment:write` to book, `appointment:cancel:*` to
  cancel, `settings:*`, `timeoff:*`, `resource:*`.
- The public booking page never says why an employee is unavailable, and
  never receives the staff-only `employeesUnavailable` list. Staff screens get
  times only, never the reason.
- Double booking is prevented by advisory locks plus the database exclusion
  constraints, including when series or bookings race.

## Web

- `/booking-settings` — company rules.
- `/time-off` — record, request, approve, reject, cancel.
- `/resources` — rooms and equipment, weekly windows, unavailable periods.
- New appointment → "Repeat this appointment": check every date, then book.
- Appointment detail → the series panel (cancel one / this and all later),
  and "Cancel anyway (late cancellation)" / "Move anyway (late change)" when
  the server allows it.
- Availability explorer → the rules that shaped the day and who is away.
- Service form → per-service rule overrides.

## Tests

- Unit: `recurrence.spec.ts`, `booking-rules.spec.ts`.
- E2E: `test/advanced-booking.e2e-spec.ts` (rules, deadlines, series,
  time off, resources, cap, races, tenant isolation).
- Web: `advanced-booking.test.tsx`, `time-off.test.tsx`.
