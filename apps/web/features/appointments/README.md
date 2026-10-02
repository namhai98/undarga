# `appointments` feature

The appointment book: list and filter, open one, book a new one, move it,
cancel it, and progress it through its statuses.

## Layout

    api/    TanStack Query hooks over `@/services/appointments.service`.
    model/  Display helpers — labels, which buttons to show, error copy.
    ui/     List, detail, booking wizard, slot picker. Only this folder is
            imported by `app/`.
    index.ts  The feature's public surface.

## Rules

- Times come from the availability engine. The booking wizard and the
  reschedule picker send back the server's own `startAt` string verbatim; the
  browser never generates, snaps or filters a slot.
- The server re-validates every booking inside a locked transaction backed by a
  database exclusion constraint. `SLOT_TAKEN` / `SLOT_UNAVAILABLE` mean the
  screen was stale: the hooks invalidate availability, and the UI asks the user
  to pick again rather than retrying.
- `ACTIONS_BY_STATUS` only decides which buttons to render. The API's
  transition graph is the authority (`docs/ARCHITECTURE-RULES.md`, rule 3).
- Instants arrive as ISO strings with the branch offset. Render the wall-clock
  part as-is — it is the time the customer was told, in the branch's zone.
- Money arrives as minor-unit strings and is formatted with `formatMoney`.
