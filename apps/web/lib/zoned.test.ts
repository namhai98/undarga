import { describe, expect, it } from 'vitest';
import { formatInZone, isoToWall, wallToIso } from './zoned';

describe('zoned wall-clock helpers', () => {
  it('reads a wall time in the named zone, not the device’s', () => {
    expect(wallToIso('2026-11-02T09:00', 'Asia/Ulaanbaatar')).toBe('2026-11-02T01:00:00.000Z');
    expect(wallToIso('2026-11-02T09:00', 'UTC')).toBe('2026-11-02T09:00:00.000Z');
  });

  it('handles a daylight-saving zone on both sides of the change', () => {
    // New York: EDT (UTC-4) until 1 Nov 2026, EST (UTC-5) after.
    expect(wallToIso('2026-10-30T09:00', 'America/New_York')).toBe('2026-10-30T13:00:00.000Z');
    expect(wallToIso('2026-11-03T09:00', 'America/New_York')).toBe('2026-11-03T14:00:00.000Z');
  });

  it('round-trips', () => {
    const iso = wallToIso('2026-11-02T22:30', 'Europe/Berlin');
    expect(isoToWall(iso, 'Europe/Berlin')).toBe('2026-11-02T22:30');
  });

  it('formats in the zone', () => {
    expect(formatInZone('2026-11-02T01:00:00.000Z', 'Asia/Ulaanbaatar')).toMatch(/9:00/);
  });
});
