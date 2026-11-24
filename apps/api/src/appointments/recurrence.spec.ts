import type { PlainDate } from '../common/time';
import { MAX_SERIES_OCCURRENCES, planOccurrences, type RecurrenceRule } from './recurrence';

const UB = 'Asia/Ulaanbaatar'; // UTC+8, no daylight saving
const NY = 'America/New_York';

function rule(overrides: Partial<RecurrenceRule>): RecurrenceRule {
  return {
    frequency: 'DAILY',
    interval: 1,
    weekdays: [],
    startDate: '2026-11-02' as PlainDate, // a Monday
    startMinutes: 10 * 60,
    count: 3,
    ...overrides,
  };
}

const dates = (r: RecurrenceRule, tz = UB) => planOccurrences(r, tz).occurrences.map((o) => o.date);

describe('planOccurrences', () => {
  it('DAILY steps by the interval and stops at the count', () => {
    expect(dates(rule({ interval: 2, count: 4 }))).toEqual([
      '2026-11-02',
      '2026-11-04',
      '2026-11-06',
      '2026-11-08',
    ]);
  });

  it('DAILY stops at the end date, inclusive', () => {
    expect(dates(rule({ count: undefined, untilDate: '2026-11-04' as PlainDate }))).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });

  it('WEEKLY with no weekdays repeats the start weekday', () => {
    expect(dates(rule({ frequency: 'WEEKLY', count: 3 }))).toEqual([
      '2026-11-02',
      '2026-11-09',
      '2026-11-16',
    ]);
  });

  it('WEEKLY on selected weekdays', () => {
    // Mon, Wed, Fri
    expect(dates(rule({ frequency: 'WEEKLY', weekdays: [1, 3, 5], count: 5 }))).toEqual([
      '2026-11-02',
      '2026-11-04',
      '2026-11-06',
      '2026-11-09',
      '2026-11-11',
    ]);
  });

  it('WEEKLY every second week skips the weeks between', () => {
    expect(dates(rule({ frequency: 'WEEKLY', interval: 2, weekdays: [1, 4], count: 4 }))).toEqual([
      '2026-11-02',
      '2026-11-05',
      '2026-11-16',
      '2026-11-19',
    ]);
  });

  it('WEEKLY never produces a date before the start', () => {
    // Starting on a Wednesday, Monday of the same week is already past.
    expect(
      dates(
        rule({
          frequency: 'WEEKLY',
          startDate: '2026-11-04' as PlainDate,
          weekdays: [1, 3],
          count: 3,
        }),
      ),
    ).toEqual(['2026-11-04', '2026-11-09', '2026-11-11']);
  });

  it('MONTHLY keeps the day of the month', () => {
    expect(
      dates(rule({ frequency: 'MONTHLY', startDate: '2026-11-15' as PlainDate, count: 3 })),
    ).toEqual(['2026-11-15', '2026-12-15', '2027-01-15']);
  });

  it('MONTHLY skips (and reports) months without that day', () => {
    const plan = planOccurrences(
      rule({ frequency: 'MONTHLY', startDate: '2027-01-31' as PlainDate, count: 3 }),
      UB,
    );
    expect(plan.occurrences.map((o) => o.date)).toEqual(['2027-01-31', '2027-03-31', '2027-05-31']);
    expect(plan.skippedDates).toEqual(['2027-02-31', '2027-04-31']);
  });

  it('MONTHLY with an end date stops before it', () => {
    expect(
      dates(
        rule({
          frequency: 'MONTHLY',
          interval: 2,
          count: undefined,
          untilDate: '2027-03-01' as PlainDate,
        }),
      ),
    ).toEqual(['2026-11-02', '2027-01-02']);
  });

  it('keeps the wall-clock time across a daylight-saving change', () => {
    // US clocks fall back on 2026-11-01: 10:00 is 14:00Z before, 15:00Z after.
    const plan = planOccurrences(
      rule({ frequency: 'WEEKLY', startDate: '2026-10-25' as PlainDate, count: 2 }),
      NY,
    );
    expect(plan.occurrences.map((o) => o.startsAt.toISOString())).toEqual([
      '2026-10-25T14:00:00.000Z',
      '2026-11-01T15:00:00.000Z',
    ]);
  });

  it('converts each local date in the branch time zone', () => {
    const [first] = planOccurrences(rule({ count: 1 }), UB).occurrences;
    expect(first?.startsAt.toISOString()).toBe('2026-11-02T02:00:00.000Z');
    expect(first?.index).toBe(0);
  });

  it('caps an open-ended rule and says so', () => {
    const plan = planOccurrences(
      rule({ count: undefined, untilDate: '2027-12-31' as PlainDate }),
      UB,
    );
    expect(plan.occurrences).toHaveLength(MAX_SERIES_OCCURRENCES);
    expect(plan.truncated).toBe(true);
  });

  it('is not truncated when the count fits', () => {
    expect(planOccurrences(rule({ count: MAX_SERIES_OCCURRENCES }), UB).truncated).toBe(false);
  });
});
