import { BookingRuleViolationError } from '../common/errors';
import {
  assertStaffCanCancel,
  assertStaffCanReschedule,
  DEFAULT_RULES,
  resolveBookingRules,
  type BookingRules,
} from './booking-rules';

describe('resolveBookingRules', () => {
  it('falls back to the defaults when nothing is saved', () => {
    expect(resolveBookingRules({ company: null, branch: null, service: null })).toEqual({
      minimumNoticeMinutes: DEFAULT_RULES.minimumNoticeMinutes,
      maximumAdvanceDays: DEFAULT_RULES.maximumAdvanceDays,
      cancellationDeadlineHours: DEFAULT_RULES.cancellationDeadlineHours,
      reschedulingAllowed: true,
      rescheduleDeadlineHours: DEFAULT_RULES.cancellationDeadlineHours,
      allowCustomerCancel: true,
      allowCustomerReschedule: true,
      maxConcurrentBookings: null,
    });
  });

  it('service overrides branch, branch overrides company', () => {
    const company = {
      bookingLeadTimeMin: 30,
      maxAdvanceBookingDays: 60,
      cancellationWindowHours: 12,
    };
    const branch = {
      bookingLeadTimeMin: 120,
      maxAdvanceBookingDays: null,
      cancellationWindowHours: 6,
    };
    const service = {
      bookingLeadTimeMin: null,
      maxAdvanceBookingDays: 14,
      cancellationWindowHours: null,
      maxConcurrentBookings: 2,
    };
    expect(resolveBookingRules({ company, branch, service })).toMatchObject({
      minimumNoticeMinutes: 120, // branch
      maximumAdvanceDays: 14, // service
      cancellationDeadlineHours: 6, // branch
      maxConcurrentBookings: 2,
    });
  });

  it('treats 0 as a real value for notice and deadlines', () => {
    const rules = resolveBookingRules({
      company: { bookingLeadTimeMin: 60, cancellationWindowHours: 24 },
      branch: null,
      service: { bookingLeadTimeMin: 0, cancellationWindowHours: 0 },
    });
    expect(rules.minimumNoticeMinutes).toBe(0);
    expect(rules.cancellationDeadlineHours).toBe(0);
  });

  it('the reschedule deadline follows the cancellation deadline unless set', () => {
    expect(
      resolveBookingRules({ company: { cancellationWindowHours: 48 }, branch: null, service: null })
        .rescheduleDeadlineHours,
    ).toBe(48);
    expect(
      resolveBookingRules({
        company: { cancellationWindowHours: 48, rescheduleDeadlineHours: 2 },
        branch: null,
        service: null,
      }).rescheduleDeadlineHours,
    ).toBe(2);
  });
});

const base: BookingRules = resolveBookingRules({
  company: { cancellationWindowHours: 24 },
  branch: null,
  service: null,
});
const now = new Date('2026-11-02T00:00:00Z');
const hoursAhead = (h: number) => new Date(now.getTime() + h * 3_600_000);

describe('assertStaffCanCancel', () => {
  it('allows a cancellation before the deadline', () => {
    expect(assertStaffCanCancel(base, hoursAhead(30), false, now)).toEqual({ isLate: false });
  });

  it('refuses a late cancellation unless confirmed', () => {
    expect(() => assertStaffCanCancel(base, hoursAhead(5), false, now)).toThrow(
      BookingRuleViolationError,
    );
    expect(assertStaffCanCancel(base, hoursAhead(5), true, now)).toEqual({ isLate: true });
  });
});

describe('assertStaffCanReschedule', () => {
  it('refuses when rescheduling is switched off, even when confirmed', () => {
    const off = { ...base, reschedulingAllowed: false };
    expect(() => assertStaffCanReschedule(off, hoursAhead(100), true, now)).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ rule: 'RESCHEDULING_DISABLED' }),
      }),
    );
  });

  it('refuses a late change unless confirmed', () => {
    const rules = { ...base, rescheduleDeadlineHours: 2 };
    expect(assertStaffCanReschedule(rules, hoursAhead(3), false, now)).toEqual({ isLate: false });
    expect(() => assertStaffCanReschedule(rules, hoursAhead(1), false, now)).toThrow(
      BookingRuleViolationError,
    );
    expect(assertStaffCanReschedule(rules, hoursAhead(1), true, now)).toEqual({ isLate: true });
  });
});
