import { describe, expect, it } from 'vitest';
import type { PublicService, PublicSlot } from '@/services/public-booking.service';
import {
  brandStyle,
  canVisit,
  customerFormSchema,
  formatDay,
  initialState,
  reducer,
  stepsFor,
} from './booking-flow';

const service = (overrides: Partial<PublicService> = {}): PublicService => ({
  id: 'svc-1',
  name: 'Haircut',
  description: null,
  durationMin: 60,
  priceMinor: '4500000',
  currencyCode: 'MNT',
  requiresEmployee: true,
  color: null,
  categoryId: null,
  ...overrides,
});
const slot: PublicSlot = {
  startAt: '2026-10-06T10:00:00+08:00',
  endAt: '2026-10-06T11:00:00+08:00',
  employeeIds: ['e1'],
};

describe('booking flow reducer', () => {
  it('skips the branch step when there is only one branch', () => {
    const s = initialState('br-1', '2026-10-06');
    expect(s.step).toBe('service');
    expect(stepsFor(s, true)).toEqual(['service', 'employee', 'time', 'details']);
  });

  it('skips the employee step for a service nobody is chosen for', () => {
    let s = initialState('br-1', '2026-10-06');
    s = reducer(s, { type: 'service', service: service({ requiresEmployee: false }) });
    expect(s.step).toBe('time');
    expect(stepsFor(s, true)).toEqual(['service', 'time', 'details']);
    // …and "back" from the time step does not land on it either.
    expect(reducer(s, { type: 'back' }).step).toBe('service');
  });

  it('clears a chosen time when an earlier choice changes', () => {
    let s = initialState(null, '2026-10-06');
    s = reducer(s, { type: 'branch', branchId: 'br-1' });
    s = reducer(s, { type: 'service', service: service() });
    s = reducer(s, { type: 'employee', employeeId: 'e1' });
    s = reducer(s, { type: 'slot', slot });
    expect(s.step).toBe('details');

    const changed = reducer(s, { type: 'service', service: service({ id: 'svc-2' }) });
    expect(changed.slot).toBeNull();
    expect(changed.employeeChosen).toBe(false);
    expect(canVisit(changed, 'details')).toBe(false);

    const newDate = reducer(s, { type: 'date', date: '2026-10-07' });
    expect(newDate.slot).toBeNull();
  });

  it('returns to the time step with a notice when the slot is lost', () => {
    let s = initialState('br-1', '2026-10-06');
    s = reducer(s, { type: 'service', service: service() });
    s = reducer(s, { type: 'employee', employeeId: null });
    s = reducer(s, { type: 'slot', slot });
    s = reducer(s, { type: 'slotLost', message: 'Taken' });
    expect(s.step).toBe('time');
    expect(s.slot).toBeNull();
    expect(s.notice).toBe('Taken');
  });

  it('refuses to jump ahead to a step whose inputs are missing', () => {
    const s = initialState(null, '2026-10-06');
    expect(reducer(s, { type: 'goto', step: 'details' }).step).toBe('branch');
  });
});

describe('brandStyle', () => {
  it('applies a plain hex colour with a readable foreground', () => {
    expect(brandStyle('#0F6B63')).toEqual({
      '--primary': '#0F6B63',
      '--primary-foreground': '#ffffff',
      '--ring': '#0F6B63',
    });
    expect(brandStyle('#fe0')?.['--primary']).toBe('#ffee00');
    expect(brandStyle('#FFEE00')?.['--primary-foreground']).toBe('#111111');
  });

  it.each(['red', 'url(x)', '#12345', '#000;background:url(javascript:x)', '', null])(
    'ignores anything that is not a plain hex colour: %s',
    (value) => {
      expect(brandStyle(value)).toBeUndefined();
    },
  );
});

describe('formatDay', () => {
  it('formats a branch calendar date without shifting it by the viewer’s zone', () => {
    expect(formatDay('2026-10-06', 'en-GB')).toBe('Tue 6 Oct');
  });
});

describe('customer form validation', () => {
  it('accepts name + phone, email optional', () => {
    expect(customerFormSchema.safeParse({ firstName: 'Nomin', phone: '+976 9911 2233', email: '' }).success).toBe(true);
  });

  it.each([
    ['missing name', { firstName: ' ', phone: '99112233' }],
    ['short phone', { firstName: 'N', phone: '12' }],
    ['letters in phone', { firstName: 'N', phone: 'call me' }],
    ['bad email', { firstName: 'N', phone: '99112233', email: 'nope' }],
  ])('rejects %s', (_label, values) => {
    expect(customerFormSchema.safeParse(values).success).toBe(false);
  });
});
