# `availability` feature

An internal surface for checking what the availability engine returns: pick a
branch, a service, a date and optionally an employee, and see the bookable
times. It is a validation tool, not the customer-facing booking page.

## Layout

    api/    TanStack Query hooks over `@/services/availability.service`.
    ui/     `AvailabilityExplorer`. Only this folder is imported by `app/`.
    index.ts  The feature's public surface.

## Rules

- The times come from the server. The browser never generates or filters a
  slot — the backend is authoritative (`docs/ARCHITECTURE-RULES.md`, rule 3).
- `availability:read` gates the screen; the API re-checks it regardless.
- Every instant the API returns is ISO-8601 with the branch offset, and the
  response names the timezone. Render times as-is; do not reinterpret them in
  the viewer's zone.
