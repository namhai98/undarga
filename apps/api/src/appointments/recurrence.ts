import { addDays, daysBetween, weekdayOf, wallToInstant, type PlainDate } from '../common/time';

/** No series may produce more than this many occurrences. */
export const MAX_SERIES_OCCURRENCES = 52;

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface RecurrenceRule {
  frequency: Frequency;
  /** Every N days / weeks / months, 1–12. */
  interval: number;
  /** WEEKLY: 0 = Sunday … 6 = Saturday. Empty = the start date's weekday. */
  weekdays: number[];
  /** The first occurrence's local date and wall-clock minutes, in the branch zone. */
  startDate: PlainDate;
  startMinutes: number;
  /** Exactly one of these ends the series. */
  untilDate?: PlainDate;
  count?: number;
}

export interface PlannedOccurrence {
  index: number;
  date: PlainDate;
  startsAt: Date;
}

export interface Plan {
  occurrences: PlannedOccurrence[];
  /** Dates the rule names that do not exist (e.g. the 31st in a 30-day month). */
  skippedDates: PlainDate[];
  /** True when the rule would produce more than MAX_SERIES_OCCURRENCES. */
  truncated: boolean;
}

/**
 * The occurrence dates of a rule, in the branch's own calendar.
 *
 * Wall-clock time is what recurs: a 10:00 weekly appointment stays at 10:00
 * across a daylight-saving change, so each instant is computed from its own
 * local date, never by adding 7 × 24 hours.
 *
 * MONTHLY repeats the start's day of the month. A month without that day is
 * SKIPPED (and reported), never silently moved to another day.
 */
export function planOccurrences(rule: RecurrenceRule, timeZone: string): Plan {
  const limit = rule.count ?? MAX_SERIES_OCCURRENCES + 1;
  const dates: PlainDate[] = [];
  const skippedDates: PlainDate[] = [];
  const within = (date: PlainDate) => !rule.untilDate || date <= rule.untilDate;
  // A hard ceiling on how far the walk may go, whatever the rule says.
  const horizon = addDays(rule.startDate, 366 * 5);

  if (rule.frequency === 'DAILY') {
    for (
      let date = rule.startDate;
      within(date) && date <= horizon && dates.length < limit;
      date = addDays(date, rule.interval)
    ) {
      dates.push(date);
    }
  } else if (rule.frequency === 'WEEKLY') {
    const weekdays = new Set(rule.weekdays.length ? rule.weekdays : [weekdayOf(rule.startDate)]);
    // Weeks counted from the Sunday on or before the start.
    const weekZero = addDays(rule.startDate, -weekdayOf(rule.startDate));
    for (
      let date = rule.startDate;
      within(date) && date <= horizon && dates.length < limit;
      date = addDays(date, 1)
    ) {
      const week = Math.floor(daysBetween(weekZero, date) / 7);
      if (week % rule.interval === 0 && weekdays.has(weekdayOf(date))) dates.push(date);
    }
  } else {
    const [y, m, d] = rule.startDate.split('-').map(Number) as [number, number, number];
    for (let step = 0; dates.length < limit; step += 1) {
      const monthIndex = m - 1 + step * rule.interval;
      const year = y + Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const first = `${year}-${String(month).padStart(2, '0')}-01` as PlainDate;
      if (!within(first) || first > horizon) break;
      if (d > daysInMonth) {
        skippedDates.push(
          `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}` as PlainDate,
        );
        continue;
      }
      const date =
        `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}` as PlainDate;
      if (!within(date)) break;
      dates.push(date);
    }
  }

  const truncated = dates.length > MAX_SERIES_OCCURRENCES;
  return {
    occurrences: dates.slice(0, MAX_SERIES_OCCURRENCES).map((date, index) => ({
      index,
      date,
      startsAt: wallToInstant(date, rule.startMinutes, timeZone),
    })),
    skippedDates,
    truncated,
  };
}
