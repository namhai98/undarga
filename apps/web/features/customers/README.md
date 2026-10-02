# `customers` feature

The people a company books work for.

## Layout

    api/    TanStack Query hooks over `@/services/customers.service`.
    ui/     Components. Only this folder is imported by `app/`.
    index.ts  The feature's public surface.

## Two things worth knowing before editing this

**A customer record belongs to one company, not to a person.** The same human
may exist in another tenant as a separate record with different notes and
different consent. That is why the same phone number is legal in two companies
and refused twice within one, and why nothing here touches `customer_identity`.

**The statistics are read-only.** `totalVisits`, `totalNoShows`,
`totalSpentMinor` and `lastVisitAt` are projections of the appointment and
payment tables. The API refuses them in a request body, so render them as
facts, never as inputs.

## Rules

- Cross-feature imports go through `index.ts`, never into `ui/` or `api/`.
- No permission decisions here. Hiding a button is a convenience and the API
  re-checks it (`docs/ARCHITECTURE-RULES.md`, rule 3). The one place this slice
  branches on a permission is the appointment history, and that is to avoid
  firing a query that is certain to 403 — not to protect anything.
- Money is a string of minor units. Display goes through `formatMoney` from
  `@undarga/shared`. Never `Number(totalSpentMinor)`.
