# `payments` feature

Online payments through the configured provider (QPay, or the local mock) —
see docs/PAYMENTS.md. The checkout panel, and the three places it is used:
an appointment (staff), a subscription invoice (owner), a public booking
(the anonymous booker, holding the confirmation's payment token).

Nothing here reports a payment as paid. The UI starts a checkout and then
reads the status the SERVER got from the provider; polling stops once the
provider has answered. No card details are ever entered in this app.

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
