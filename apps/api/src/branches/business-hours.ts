/**
 * Business-hours rows for one branch, for one `effectiveFrom`.
 *
 * Shared by `PUT /branches/:id/business-hours` and company onboarding, so a
 * week is turned into rows by exactly one rule: all seven days are written,
 * and a day the caller left out is CLOSED rather than missing — "missing"
 * would read as "no information" to the availability engine.
 */
export function businessWeekRows(
  companyId: string,
  branchId: string,
  days: ReadonlyArray<{
    dayOfWeek: number;
    isClosed: boolean;
    opensAt?: string;
    closesAt?: string;
  }>,
  effectiveFrom: Date,
) {
  const supplied = new Map(days.map((d) => [d.dayOfWeek, d]));

  return Array.from({ length: 7 }, (_, dayOfWeek) => {
    const day = supplied.get(dayOfWeek);
    const closed = !day || day.isClosed;

    return {
      companyId,
      branchId,
      dayOfWeek,
      isClosed: closed,
      // `@db.Time(0)` — Prisma takes a Date and keeps the time part. The
      // date component is arbitrary and never read.
      opensAt: closed ? null : new Date(`1970-01-01T${day.opensAt}:00.000Z`),
      closesAt: closed ? null : new Date(`1970-01-01T${day.closesAt}:00.000Z`),
      effectiveFrom,
      // `crossesMidnight` is deliberately not set here: a trigger derives
      // it from the times, so the flag cannot disagree with them.
    };
  });
}

/** `YYYY-MM-DD` (default today, UTC) as the `@db.Date` value Prisma expects. */
export function effectiveFromDate(day?: string): Date {
  return new Date(`${day ?? new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
}
