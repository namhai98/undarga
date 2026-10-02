import { addInterval, effectiveStatus, grantsAccess } from './subscription-state';

const now = new Date('2026-10-02T00:00:00Z');
const past = new Date('2026-10-01T00:00:00Z');
const future = new Date('2026-10-03T00:00:00Z');
const clock = (o: Partial<Parameters<typeof effectiveStatus>[0]>) => ({
  status: 'ACTIVE' as const,
  trialEndsAt: null,
  currentPeriodEnd: future,
  graceEndsAt: null,
  ...o,
});

describe('effectiveStatus', () => {
  it('ends a trial the moment it is over, without waiting for the sweep', () => {
    expect(effectiveStatus(clock({ status: 'TRIAL', trialEndsAt: future }), now)).toBe('TRIAL');
    expect(effectiveStatus(clock({ status: 'TRIAL', trialEndsAt: past }), now)).toBe('EXPIRED');
  });

  it('keeps a cancelled subscription usable until its period ends', () => {
    expect(effectiveStatus(clock({ status: 'CANCELLED', currentPeriodEnd: future }), now)).toBe(
      'CANCELLED',
    );
    expect(effectiveStatus(clock({ status: 'CANCELLED', currentPeriodEnd: past }), now)).toBe(
      'EXPIRED',
    );
  });

  it('expires a past-due subscription when its grace period ends', () => {
    expect(effectiveStatus(clock({ status: 'PAST_DUE', graceEndsAt: future }), now)).toBe(
      'PAST_DUE',
    );
    expect(effectiveStatus(clock({ status: 'PAST_DUE', graceEndsAt: past }), now)).toBe('EXPIRED');
  });

  it('leaves ACTIVE alone — renewal is the sweep’s job', () => {
    expect(effectiveStatus(clock({ status: 'ACTIVE', currentPeriodEnd: past }), now)).toBe(
      'ACTIVE',
    );
  });

  it('grants access in every state but EXPIRED and the reserved ones', () => {
    expect(
      ['TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED'].every((s) => grantsAccess(s as never)),
    ).toBe(true);
    expect(grantsAccess('EXPIRED')).toBe(false);
    expect(grantsAccess('SUSPENDED')).toBe(false);
  });
});

describe('addInterval', () => {
  it('adds a calendar month or year', () => {
    expect(addInterval(new Date('2026-01-15T00:00:00Z'), 'MONTH').toISOString()).toBe(
      '2026-02-15T00:00:00.000Z',
    );
    expect(addInterval(new Date('2026-01-15T00:00:00Z'), 'YEAR').toISOString()).toBe(
      '2027-01-15T00:00:00.000Z',
    );
  });
});
