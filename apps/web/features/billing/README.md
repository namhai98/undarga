# `billing` feature

Payments, gift cards and promotions.

## Layout

    api/    TanStack Query hooks over `@/services/billing.service`.
    ui/     Components. Only this folder is imported by `app/`.

## Three things worth knowing before editing this

**Money never becomes a number.** Every amount is a string of minor units.
Display goes through `formatMoney`, input through `decimalToMinorString`, both
from `@undarga/shared`. `Number(amountMinor)` is always a bug.

**No discount amount is ever sent for a booking.** The client names a
promotion; the server decides what it is worth. The quote endpoint and the
apply endpoint share one evaluator, so the price on the screen is the price
that gets charged.

**A gift-card code exists once.** It is in the issue response and nowhere else —
not in the cache, not in a later fetch. `useIssueGiftCard` deliberately does
not write it into the query cache, and the component that shows it drops it.

## Rules

- Cross-feature imports go through `index.ts`.
- No permission decisions here. Hiding the refund button is a convenience; the
  API re-checks `payment:refund` (`docs/ARCHITECTURE-RULES.md`, rule 3).
- Money mutations invalidate the analytics cache too — an owner who takes a
  payment and watches the dashboard not move reads that as a broken payment.
