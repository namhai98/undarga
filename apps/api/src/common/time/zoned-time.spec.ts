import {
  addDays,
  daysBetween,
  formatOffset,
  hhmmToMinutes,
  isPlainDate,
  parsePlainDate,
  prismaTimeToMinutes,
  todayInZone,
  toIsoWithOffset,
  wallToInstant,
  weekdayOf,
  zoneOffsetMinutes,
  type PlainDate,
} from './zoned-time';

const d = (s: string) => parsePlainDate(s);

describe('zoned-time', () => {
  describe('parsePlainDate', () => {
    it('accepts a real date', () => {
      expect(parsePlainDate('2026-09-15')).toBe('2026-09-15');
    });

    it('rejects a malformed string', () => {
      expect(() => parsePlainDate('2026-9-15')).toThrow();
      expect(() => parsePlainDate('15/09/2026')).toThrow();
      expect(isPlainDate('nonsense')).toBe(false);
    });

    it('rejects a day that does not exist', () => {
      expect(() => parsePlainDate('2023-02-29')).toThrow();
      expect(() => parsePlainDate('2026-13-01')).toThrow();
      expect(parsePlainDate('2024-02-29')).toBe('2024-02-29'); // leap year
    });
  });

  describe('weekdayOf', () => {
    it('is 0=Sunday .. 6=Saturday', () => {
      expect(weekdayOf(d('2000-01-01'))).toBe(6); // Saturday
      expect(weekdayOf(d('2024-02-29'))).toBe(4); // Thursday
      expect(weekdayOf(d('2026-09-15'))).toBe(2); // Tuesday
    });
  });

  describe('addDays / daysBetween', () => {
    it('crosses month and leap-year boundaries', () => {
      expect(addDays(d('2026-03-01'), -1)).toBe('2026-02-28');
      expect(addDays(d('2024-03-01'), -1)).toBe('2024-02-29');
      expect(addDays(d('2026-12-31'), 1)).toBe('2027-01-01');
    });

    it('counts whole days', () => {
      expect(daysBetween(d('2026-09-10'), d('2026-09-15'))).toBe(5);
      expect(daysBetween(d('2026-09-15'), d('2026-09-15'))).toBe(0);
      expect(daysBetween(d('2026-09-15'), d('2026-09-10'))).toBe(-5);
    });
  });

  describe('zoneOffsetMinutes', () => {
    it('tracks DST for a DST zone', () => {
      expect(zoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-300);
      expect(zoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-240);
    });

    it('is fixed for a non-DST zone', () => {
      expect(zoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Asia/Ulaanbaatar')).toBe(480);
      expect(zoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'Asia/Ulaanbaatar')).toBe(480);
    });

    it('handles a fractional offset', () => {
      expect(zoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'Asia/Kathmandu')).toBe(345);
    });
  });

  describe('wallToInstant', () => {
    it('converts a normal wall time in a fixed-offset zone', () => {
      expect(wallToInstant(d('2026-09-15'), 9 * 60, 'Asia/Ulaanbaatar').toISOString()).toBe(
        '2026-09-15T01:00:00.000Z',
      );
    });

    it('applies the right offset either side of a DST boundary', () => {
      expect(wallToInstant(d('2026-01-15'), 9 * 60, 'America/New_York').toISOString()).toBe(
        '2026-01-15T14:00:00.000Z', // EST, -5
      );
      expect(wallToInstant(d('2026-07-15'), 9 * 60, 'America/New_York').toISOString()).toBe(
        '2026-07-15T13:00:00.000Z', // EDT, -4
      );
    });

    it('shifts a nonexistent spring-forward local time forward by the gap', () => {
      // 2026-03-08 02:30 America/New_York never happens (02:00 -> 03:00).
      expect(wallToInstant(d('2026-03-08'), 2 * 60 + 30, 'America/New_York').toISOString()).toBe(
        '2026-03-08T07:30:00.000Z', // == 03:30 EDT
      );
    });

    it('resolves an ambiguous fall-back local time to the first occurrence', () => {
      // 2026-11-01 01:30 America/New_York happens twice (02:00 EDT -> 01:00 EST).
      expect(wallToInstant(d('2026-11-01'), 60 + 30, 'America/New_York').toISOString()).toBe(
        '2026-11-01T05:30:00.000Z', // the earlier, EDT occurrence
      );
    });

    it('accepts minutes past 1440 for an end-of-day boundary', () => {
      expect(wallToInstant(d('2026-09-15'), 24 * 60, 'Asia/Ulaanbaatar').toISOString()).toBe(
        '2026-09-15T16:00:00.000Z', // 2026-09-16 00:00 +08:00
      );
    });
  });

  describe('formatOffset', () => {
    it.each([
      [480, '+08:00'],
      [-300, '-05:00'],
      [345, '+05:45'],
      [0, '+00:00'],
    ])('formats %i as %s', (mins, expected) => {
      expect(formatOffset(mins)).toBe(expected);
    });
  });

  describe('toIsoWithOffset', () => {
    it('renders the instant in the zone with its offset', () => {
      expect(toIsoWithOffset(new Date('2026-09-15T01:00:00Z'), 'Asia/Ulaanbaatar')).toBe(
        '2026-09-15T09:00:00+08:00',
      );
      expect(toIsoWithOffset(new Date('2026-07-15T13:00:00Z'), 'America/New_York')).toBe(
        '2026-07-15T09:00:00-04:00',
      );
    });
  });

  describe('todayInZone', () => {
    it('is the calendar date the zone is on, not the server', () => {
      // 20:00Z is already the next day in UB (+08:00).
      expect(todayInZone('Asia/Ulaanbaatar', new Date('2026-09-14T20:00:00Z'))).toBe('2026-09-15');
      expect(todayInZone('America/New_York', new Date('2026-09-15T02:00:00Z'))).toBe('2026-09-14');
    });
  });

  describe('column helpers', () => {
    it('parses HH:MM including the 24:00 end boundary', () => {
      expect(hhmmToMinutes('09:00')).toBe(540);
      expect(hhmmToMinutes('22:30')).toBe(1350);
      expect(hhmmToMinutes('24:00')).toBe(1440);
      expect(() => hhmmToMinutes('9:00')).toThrow();
      expect(() => hhmmToMinutes('24:01')).toThrow();
    });

    it('reads a @db.Time column back as minutes from midnight', () => {
      expect(prismaTimeToMinutes(new Date('1970-01-01T09:30:00.000Z'))).toBe(570);
      expect(prismaTimeToMinutes(new Date('1970-01-01T00:00:00.000Z'))).toBe(0);
    });
  });
});

// Type-only: PlainDate is a branded string.
const _brand: PlainDate = parsePlainDate('2026-01-01');
void _brand;
