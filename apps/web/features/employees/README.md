# `employees` feature

Placeholder. Nothing is implemented yet.

## Layout

    api/    TanStack Query hooks over `@/services`. One file per resource.
    model/  View state only — never business rules.
    ui/     Components. Only this folder is imported by `app/`.
    index.ts  The feature's public surface.

## Rules

- Cross-feature imports go through `index.ts`, never into `ui/` or `api/` directly.
- No price arithmetic, no availability calculation, no permission decisions here.
  The server decides all three; hiding a button by permission is a convenience,
  and the API re-checks it. See `docs/ARCHITECTURE-RULES.md`, rule 3.
- Money arrives as `{ amountMinor, currencyCode }` and is formatted with
  `formatMoney` from `@undarga/shared`. Never parse a displayed string back.
