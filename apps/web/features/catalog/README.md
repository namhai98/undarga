# `catalog` feature

Services and service categories — what a company sells, and how it is grouped.

## Layout

    api/    TanStack Query hooks over `@/services/catalog.service`.
    ui/     Components. Only this folder is imported by `app/`.
    index.ts  The feature's public surface.

## Two things worth knowing before editing this

**Bookable is not public.** `status: ACTIVE` decides whether a service can be
booked at all; `isOnlineBookable` decides whether the public booking site lists
it. An internal-only service — staff training, a supplier visit — is active and
unlisted. There is deliberately no third flag.

**`/services/:id/employees` and `/employees/:id/services` are the same row.**
Both write `employee_service`. Assigning from either direction produces one
record, so every mutation here invalidates `employeeKeys` as well as
`catalogKeys`. Skipping that is how the staff screen ends up showing an
assignment the database no longer has.

## Rules

- Cross-feature imports go through `index.ts`, never into `ui/` or `api/`.
- No price arithmetic, no availability calculation, no permission decisions
  here. The server decides all three; hiding a button by permission is a
  convenience and the API re-checks it. See `docs/ARCHITECTURE-RULES.md`, rule 3.
- Money is a string of minor units. Display goes through `formatMoney` from
  `@undarga/shared`; input goes back through `decimalToMinorString`. Never
  `Number(priceMinor)`.
