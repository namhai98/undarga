# `analytics` feature

The dashboard and the reports page (appointments, customers, services,
promotions, gift cards, and — with `report:revenue:read` — revenue).

## Layout

    api/    TanStack Query hooks over `@/services/analytics.service`.
    model/  Display helpers: labels, basis points → %, money-or-dash, date presets.
    ui/     Components. Only this folder is imported by `app/`.

Charts are `@/components/charts` — small SVG charts with a screen-reader table
behind each. No chart library.

## Things worth knowing before editing this

**Nothing is computed here.** Every figure comes aggregated from the server;
the UI formats and draws. Filters are validated and scoped on the server
(tenant, branch scope, permissions); the dropdowns are a convenience.

**Counts need `report:read`; money needs `report:revenue:read`.** Without the
second, every amount arrives as `null` and renders as a dash, and the
dashboard's `restricted` list says what was withheld — never a zero.

**Revenue means money TAKEN, not money booked.** Settled payments net of
refunds. "Booked value" is labelled as such and is not revenue.

**Days are the company's days.** The server buckets by the company timezone;
the browser sends plain `YYYY-MM-DD` dates and no offset.

## Rules

- Cross-feature imports go through `index.ts`.
- Rates are basis points on the wire (1250 = 12.5%) and only become a
  percentage string at the point of display.
- Money is a string of minor units, formatted with `formatMoney`.
