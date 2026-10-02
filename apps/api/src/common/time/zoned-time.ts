/**
 * Wall-clock ↔ instant conversion, DST-correct, with no dependency.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Booking arithmetic is done in the BRANCH timezone (docs/DATABASE.md §6). A
 * request for `2026-09-15` means that calendar date as the branch reads it, and
 * `business_hours` / `employee_schedule` store `09:00` as a wall-clock `time`,
 * not an instant. Something has to turn "09:00 local on 2026-09-15 in
 * Asia/Ulaanbaatar" into a UTC instant, and do it correctly across a
 * daylight-saving transition.
 *
 * Node ships a full IANA database inside `Intl`, and that is the only reliable
 * source here — a fixed offset is wrong twice a year for any DST zone, and
 * `new Date('2026-09-15')` parses as UTC midnight, which is the previous
 * evening in Ulaanbaatar. So every conversion goes through `Intl`, and nothing
 * in the availability engine constructs a `Date` from a local string directly.
 *
 * ---------------------------------------------------------------------------
 * TRANSITION SEMANTICS (documented, deterministic — see zoned-time.spec.ts)
 * ---------------------------------------------------------------------------
 *
 *   Spring forward — a local time that never happens (e.g. 02:30 when clocks
 *   jump 02:00 → 03:00). `wallToInstant` returns the instant the post-jump
 *   offset places it at, i.e. it is shifted forward by the gap. A slot
 *   generator stepping across the gap therefore never emits a nonexistent
 *   instant.
 *
 *   Fall back — a local time that happens twice. `wallToInstant` returns the
 *   FIRST (pre-transition, larger-offset) occurrence. Availability is a
 *   superset in that hour, which is the safe direction for a read: the
 *   Appointment Engine re-checks under the exclusion constraint.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** A validated `YYYY-MM-DD`. */
export type PlainDate = string & { readonly __plainDate: unique symbol };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse and validate a `YYYY-MM-DD` string, rejecting impossible dates. */
export function parsePlainDate(value: string): PlainDate {
  const match = DATE_RE.exec(value);
  if (!match) {
    throw new RangeError(`Not a YYYY-MM-DD date: "${value}"`);
  }
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  // Round-trip through UTC to reject 2026-02-30 and friends.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new RangeError(`Not a real calendar date: "${value}"`);
  }
  return value as PlainDate;
}

export function isPlainDate(value: string): boolean {
  try {
    parsePlainDate(value);
    return true;
  } catch {
    return false;
  }
}

/** `0` = Sunday … `6` = Saturday, matching the `day_of_week` column. */
export function weekdayOf(date: PlainDate): number {
  const [, y, m, d] = DATE_RE.exec(date)!;
  // A calendar date's weekday does not depend on a timezone.
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).getUTCDay();
}

/** Shift a plain date by whole days. Negative goes back. */
export function addDays(date: PlainDate, days: number): PlainDate {
  const [, y, m, d] = DATE_RE.exec(date)!;
  const shifted = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + days));
  const iso = shifted.toISOString().slice(0, 10);
  return iso as PlainDate;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    // Constructing with an unknown zone throws a RangeError here — which is the
    // right place for it to fail, loudly, rather than producing wrong instants.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Break an instant down into the wall-clock fields a given zone shows for it. */
function zonedPartsAt(instant: Date, timeZone: string): ZonedParts {
  const map: Record<string, string> = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  let hour = Number(map.hour);
  // Some engines emit "24" for midnight under h23; normalise it.
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/**
 * Minutes that `timeZone` is ahead of UTC at `instant`.
 *
 * `+480` for Asia/Ulaanbaatar, `-300` for America/New_York in winter, `-240`
 * in summer. Derived by asking the zone what wall-clock time it shows for the
 * instant and measuring the difference.
 */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const p = zonedPartsAt(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asIfUtc - instant.getTime()) / MINUTE_MS);
}

/**
 * The UTC instant of a wall-clock time on a plain date in a zone.
 *
 * `minutesFromMidnight` may exceed 1440 (`24:00` → `1440`, used for a window
 * that closes at end of day, and for the tail of an overnight shift), and may
 * be negative for symmetry — the arithmetic just carries into the next or
 * previous day.
 *
 * The two-pass method: assume the wall time is UTC, read the zone's offset
 * there, correct by it, then re-read the offset at the corrected instant. When
 * the two agree (the common case) the answer is exact. When they disagree a
 * transition sits between them, and the fixed points are resolved per the
 * semantics in this file's header.
 */
export function wallToInstant(
  date: PlainDate,
  minutesFromMidnight: number,
  timeZone: string,
): Date {
  const [, y, m, d] = DATE_RE.exec(date)!;
  const base = Date.UTC(Number(y), Number(m) - 1, Number(d)) + minutesFromMidnight * MINUTE_MS;

  const offset1 = zoneOffsetMinutes(new Date(base), timeZone);
  const guess1 = base - offset1 * MINUTE_MS;
  const offset2 = zoneOffsetMinutes(new Date(guess1), timeZone);
  if (offset2 === offset1) return new Date(guess1);

  // A transition is in play. Try the second offset as the fixed point.
  const guess2 = base - offset2 * MINUTE_MS;
  const offset3 = zoneOffsetMinutes(new Date(guess2), timeZone);
  if (offset3 === offset2) return new Date(guess2);

  // Neither offset is a fixed point: the local time falls inside the gap of a
  // spring-forward. Fall back to the pre-transition offset, which lands the
  // instant just past the jump — shifted forward by the gap, never nonexistent.
  return new Date(base - offset1 * MINUTE_MS);
}

/** Instant of local midnight (00:00) that starts `date` in `timeZone`. */
export function startOfLocalDay(date: PlainDate, timeZone: string): Date {
  return wallToInstant(date, 0, timeZone);
}

/** Instant of the following local midnight — the exclusive end of `date`. */
export function endOfLocalDay(date: PlainDate, timeZone: string): Date {
  return wallToInstant(date, 24 * 60, timeZone);
}

/** The plain date currently in effect in `timeZone`. */
export function todayInZone(timeZone: string, now: Date = new Date()): PlainDate {
  const p = zonedPartsAt(now, timeZone);
  const iso = `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(
    p.day,
  ).padStart(2, '0')}`;
  return iso as PlainDate;
}

/** Whole calendar days from `from` to `to` in the same zone (`to - from`). */
export function daysBetween(from: PlainDate, to: PlainDate): number {
  const [, fy, fm, fd] = DATE_RE.exec(from)!;
  const [, ty, tm, td] = DATE_RE.exec(to)!;
  const a = Date.UTC(Number(fy), Number(fm) - 1, Number(fd));
  const b = Date.UTC(Number(ty), Number(tm) - 1, Number(td));
  return Math.round((b - a) / DAY_MS);
}

/** `+08:00`, `-05:00`, `+05:45`. */
export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/**
 * An instant rendered in a zone as an ISO-8601 string WITH the offset, e.g.
 * `2026-09-15T09:00:00+08:00`. Every API response carrying an instant carries
 * the zone alongside it (docs/DATABASE.md §16.4); this is the paired string
 * form.
 */
export function toIsoWithOffset(instant: Date, timeZone: string): string {
  const p = zonedPartsAt(instant, timeZone);
  const offset = zoneOffsetMinutes(instant, timeZone);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T` +
    `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${formatOffset(offset)}`
  );
}

/** `"09:00"` / `"22:30"` → minutes from midnight. `"24:00"` → 1440. */
export function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new RangeError(`Not an HH:MM time: "${hhmm}"`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) {
    throw new RangeError(`Not a valid HH:MM time: "${hhmm}"`);
  }
  return hours * 60 + minutes;
}

/**
 * A `@db.Time(0)` column comes back from Prisma as a `Date` on 1970-01-01 whose
 * UTC time part is the stored wall-clock time. Extract that as minutes from
 * midnight.
 */
export function prismaTimeToMinutes(value: Date): number {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}
