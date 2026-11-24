# Performance

What was measured, what changed, and what was tried and dropped (Task #29).
Every figure below comes from the tools in this document, run on the
conditions stated. Nothing is estimated.

## How to measure

A dedicated database keeps benchmarks away from development and e2e data.

```bash
# once: create undarga_bench (any superuser), then migrate and harden it
DATABASE_URL=…/undarga_bench MIGRATION_DATABASE_URL=…/undarga_bench PLATFORM_DATABASE_URL=…/undarga_bench \
  pnpm --filter @undarga/api exec prisma migrate deploy && node scripts/apply-hardening.js

# data: truncates the bench database and seeds it (refuses any other database)
pnpm --filter @undarga/api bench:seed

# endpoints: label, runs per endpoint (also refuses a non-bench database)
NOTIFICATION_WORKER_ENABLED=false SUBSCRIPTION_SWEEP_ENABLED=false \
CALENDAR_SYNC_ENABLED=false FILE_CLEANUP_ENABLED=false NODE_ENV=development \
  pnpm --filter @undarga/api bench:endpoints mylabel 60
```

- `scripts/bench-seed.ts` — company A: 1 branch, 25 staff, 30 services,
  20 000 customers, ~41 000 appointments (18 months back, 2 months ahead),
  ~20 000 notifications. Company B: a tenth of that, so every query also has
  rows it must skip. Totals: 44 878 appointments, 22 002 customers.
- `scripts/bench-endpoints.ts` — boots the real app in-process (guards, RLS,
  tenant transactions) and calls ~20 endpoints sequentially: 3 warm-up runs,
  then N measured. Reports p50 / p95 and SQL statements per request, and
  writes the slowest statements to `apps/api/bench-results/<label>.json`.
  Background workers must be off, or their queries are counted too.
  `BENCH_ONLY=<name>` limits the endpoints (e.g. under `node --cpu-prof`);
  `BENCH_TRACE=<name>` prints every statement of one request.
- `scripts/bench-explain.cjs` — `EXPLAIN (ANALYZE, BUFFERS)` of captured
  statements **as the tenant role, with RLS active** — plans as the owner
  role differ (see "Row-level security and indexes").

Conditions for the numbers below: Windows 11, Node 24.19, PostgreSQL 18.6 on
the same machine, no Redis, `NODE_ENV=development` (production refuses local
settings), 60 measured requests per endpoint. Before and after were run back
to back with the original code temporarily restored, because run-to-run
variation on this machine is about ±10% (unchanged endpoints moved that much).

## Results (API, p50 / p95 ms)

| Endpoint | Before | After | |
|---|---|---|---|
| Customers: list (25) | 43.6 / 56.3 | **13.1 / 16.4** | −70% |
| Report: services, 90 days | 107.3 / 114.4 | **42.1 / 46.9** | −61% |
| Appointment detail | 16.4 / 21.7 | **10.0 / 15.6** | −39% |
| Customers: search by name | 52.9 / 57.7 | **32.4 / 36.1** | −39% |
| Report: appointments, 90 days | 67.5 / 72.4 | **52.8 / 58.9** | −22% |
| Report: customers, 90 days | 30.6 / 33.9 | 28.0 / 30.9 | −8% (noise band) |
| Report: revenue, 90 days | 5.7 / 8.2 | 7.8 / 10.5 | **+2 ms** (see below) |
| Availability, day, all staff | 26.2 / 31.7 | 24.2 / 32.8 | noise band; CPU −87%, below |
| Customers: search by phone | 55.8 / 62.2 | 54.5 / 59.8 | unchanged (see below) |
| Dashboard, lists, public pages | — | — | unchanged (±10%) |

Availability CPU (`node --cpu-prof`, 200 requests): self time in
`common/time/zoned-time.ts` 692 ms → 92 ms, i.e. ~3.4 → ~0.45 ms per request.
Single-request latency is dominated by database waits, so this shows up as
capacity under concurrency rather than as p50.

Background job: the reminder sweep (runs every 15 s, across all companies)
went from reading every future active booking (4 480 rows, 4.3 ms) to only the
due window (0.53 ms) — and it no longer grows with how far ahead bookings exist
or with the number of companies.

## What changed

1. **Customer list: no `_count` include.** Prisma's
   `_count: { appointments }` compiled to counting every appointment in the
   company and joining that to every customer before the page was cut. The
   list now counts appointments for the page's customers in one grouped query.
   Same response.
2. **Reports: enum comparison, item date range, custom plans.**
   - `a.status::text = ANY(text[])` hid the column statistics (the planner
     expected ~200 of 6 000 rows); comparing the enum fixes the estimate.
   - Items are also bounded by date. An item never starts before its
     appointment (both are written with the same start), and the upper bound
     has a week of margin, so this drops nothing — it only lets the item side
     be read by range instead of in full, so a report costs what its period
     holds, not the company's whole history.
   - `SET LOCAL plan_cache_mode = force_custom_plan` in the report
     transaction. Prisma runs raw SQL as prepared statements; after a few
     executions Postgres may switch to a generic plan, which for these joins
     was measured at 37 ms vs 9 ms. The cost is a few ms of planning per
     query — which is why the small revenue report is ~2 ms slower.
3. **Appointment detail:** index `(company_id, rescheduled_from_id)` (partial)
   for the "rescheduled to" lookup, which scanned the company's appointments.
4. **Availability:** exact memo of time-zone conversions (`Intl`
   `formatToParts` was the hottest function; same zone + instant always gives
   the same answer). Bounded at 20 000 entries; entries are frozen.
5. **Reminder sweep:** a constant upper bound on `starts_at` (the largest
   configured offset, read in the same query), so the index reads only the
   due window.
6. **Unused index dropped:** `company_customer_name_trgm_idx` matched no
   query; it only cost writes.
7. **Images:** `sharp.cache(false)` — each upload is decoded once, so libvips'
   cache only held memory and file handles (on Windows, locking temp files).
8. **Web bundles:** `"sideEffects"` in `apps/web/package.json` declares the
   feature slices side-effect free (everything else unchanged), so importing a
   hook through a feature's index no longer pulls that feature's whole UI.

### Web: JavaScript per page (gzip, all scripts in the served HTML)

Measured with `next build` + `next start`, fetching every `<script src>`
and preload of each page and gzipping it.

| Page | Before | sideEffects (Next 16.3.8) | Final (Next 16.4.1) |
|---|---|---|---|
| /appointments | 293.2 KB | 242.8 KB | 234.7 KB (−58.5) |
| /appointments/new | 293.2 KB | 247.6 KB | 239.3 KB (−53.9) |
| /payments | 278.2 KB | 242.3 KB | 234.3 KB (−43.9) |
| /dashboard | 266.8 KB | 236.2 KB | 233.1 KB (−33.7) |
| /reports | 265.6 KB | 245.5 KB | 237.4 KB (−28.2) |
| /customers | 255.5 KB | 242.8 KB | 234.8 KB (−20.7) |
| /booking-settings | 247.2 KB | 239.8 KB | 232.0 KB (−15.2) |
| /platform | 238.0 KB | 239.8 KB | 231.8 KB (−6.2) |
| /book/[slug] (public) | 241.9 KB | 248.2 KB | 240.3 KB (−1.6) |
| /portal/[slug] | 238.9 KB | 244.1 KB | 236.0 KB (−2.9) |
| /login | 228.0 KB | 230.9 KB | 223.7 KB (−4.3) |

Two separate effects. The `sideEffects` declaration alone (middle column)
cut the staff pages by 7–50 KB but added 3–6 KB to the public pages, because
Turbopack lays the smaller per-route chunks out differently (some shared UI
lands in two chunks). The Next.js 16.4.1 security upgrade (docs/SECURITY.md)
then shaved ~7–8 KB off every page. Net, every measured page is smaller; the
public pages' net gain comes from the upgrade, not from the bundling change.

## Tried and dropped

- **Trigram indexes for customer search** (first name, last name, email,
  phone). As the owner role they turned a 16–19 ms scan into 0.3–1.5 ms. As the
  app role they are **never used**: see below. Dropped, with the email
  rewrite and migration that went with them.
- **Partial index for the dashboard's "outstanding" total** — the same reason.
- **Redis caching of public company/catalog pages** — they answer in ~9–11 ms
  with six small queries; caching would save a few ms at the cost of
  invalidation on every company, branch, service, branding and media write,
  i.e. a real risk of stale booking pages. Not worth it at these numbers.
- **Lazy-loading the payment and recurring-booking panels** — a few KB each;
  not worth the extra loading states.

## Row-level security and indexes

Under RLS, Postgres only lets **leakproof** operators drive an index scan
before the policy is applied. Equality on uuid, integers, text and timestamp
ranges is leakproof — so `(company_id, starts_at)`-style indexes work.
`LIKE`/`ILIKE` and **enum** comparisons are not — so trigram indexes and
partial indexes keyed on `status` are not chosen for the app role, however
good they look in an `EXPLAIN` run as the owner. Always check plans as the
tenant role (`bench-explain.cjs` does).

## Remaining bottlenecks and recommendations

- **Customer search** (~32 ms by name, ~54 ms by phone at 20 000 customers)
  scans the company's customers twice (rows + total). Options, in order of
  effort: a normalised, leakproof-searchable column (e.g. digits-only phone
  with btree prefix search), or a search function that applies the company
  filter itself (`SECURITY DEFINER`) — the latter needs a security review.
- **Dashboard "outstanding"** scans the appointment history (~17 ms at 45 000
  rows) for the same RLS reason. A maintained `is_outstanding` boolean (or a
  per-company counter) would make it constant.
- **Appointment lists** (~17–20 ms) are not database-bound (every statement
  < 1 ms); the time is Prisma, serialization and the tenant transaction
  round trips. Selecting fewer columns would help modestly.
- **Notification sending** is sequential per replica (50 per tick). Bounded
  concurrency (e.g. 5) would raise throughput, but must respect provider
  limits (Twilio long codes ~1 message/s).
- **CREATE INDEX** in `001_hardening.sql` runs inside one transaction; on large
  production tables build new indexes `CONCURRENTLY` before deploying.
- Dev-tool advisories (vitest 2 / vite 5) remain; see docs/SECURITY.md.
