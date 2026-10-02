import { computeAvailability } from './availability.engine';
import type { AvailabilityEngineInput } from './availability.types';
import type { Interval } from './interval';

const H = 3_600_000;
const M = 60_000;
/** Arbitrary "local midnight" instant — the pure engine does not care which. */
const DAY0 = Date.UTC(2026, 8, 15, 0, 0, 0);
const at = (hours: number, minutes = 0): number => DAY0 + hours * H + minutes * M;
const span = (fromH: number, toH: number): Interval => ({ start: at(fromH), end: at(toH) });

function baseInput(overrides: Partial<AvailabilityEngineInput> = {}): AvailabilityEngineInput {
  return {
    businessWindows: [span(9, 18)],
    serviceWindows: null,
    gridAnchor: DAY0,
    slotIntervalMs: 30 * M,
    serviceDurationMs: 60 * M,
    bufferBeforeMs: 0,
    bufferAfterMs: 0,
    earliestStart: Number.NEGATIVE_INFINITY,
    requiresEmployee: false,
    requiresResource: false,
    employees: [],
    resourceRequirements: [],
    ...overrides,
  };
}

/** Slot start hours, for compact assertions. */
const startHours = (input: AvailabilityEngineInput): number[] =>
  computeAvailability(input).map((s) => (s.startAt - DAY0) / H);

describe('availability engine', () => {
  describe('scenario 1 — basic availability', () => {
    it('fills the opening hours on the slot grid', () => {
      const slots = computeAvailability(baseInput());
      expect(startHours(baseInput())).toEqual([
        9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17,
      ]);
      // Last slot ends exactly at close; nothing starts at 17:30.
      expect(slots[slots.length - 1]!.endAt).toBe(at(18));
      expect(slots[0]!.employeeIds).toEqual([]);
      expect(slots[0]!.resourceIds).toEqual([]);
    });

    it('reports the reserved window separately from the appointment', () => {
      const [slot] = computeAvailability(
        baseInput({ bufferBeforeMs: 10 * M, bufferAfterMs: 15 * M }),
      );
      expect(slot!.startAt).toBe(at(9));
      expect(slot!.endAt).toBe(at(10));
      expect(slot!.reservedStart).toBe(at(8, 50));
      expect(slot!.reservedEnd).toBe(at(10, 15));
    });
  });

  describe('scenario 2 — employee break', () => {
    it('never returns a slot overlapping the break', () => {
      const input = baseInput({
        slotIntervalMs: 60 * M,
        requiresEmployee: true,
        employees: [
          // Caller has already subtracted the 12:00–13:00 break.
          { employeeId: 'e1', workWindows: [span(9, 12), span(13, 18)], busy: [] },
        ],
      });
      expect(startHours(input)).toEqual([9, 10, 11, 13, 14, 15, 16, 17]);
      expect(computeAvailability(input).every((s) => s.employeeIds.includes('e1'))).toBe(true);
    });
  });

  describe('scenario 3 — existing appointment', () => {
    it('excludes the overlapping start but allows the abutting one', () => {
      const input = baseInput({
        slotIntervalMs: 60 * M,
        requiresEmployee: true,
        employees: [{ employeeId: 'e1', workWindows: [span(9, 18)], busy: [span(10, 11)] }],
      });
      const hours = startHours(input);
      expect(hours).not.toContain(10);
      expect(hours).toContain(9); // 09:00–10:00 abuts, does not overlap
      expect(hours).toContain(11);
    });
  });

  describe('scenario 4 — buffers', () => {
    it('rejects a start whose buffered window hits a busy interval', () => {
      const input = baseInput({
        serviceDurationMs: 60 * M,
        bufferAfterMs: 15 * M,
        slotIntervalMs: 30 * M,
        requiresEmployee: true,
        employees: [
          // Existing booking 10:00–11:00 with its own 15-minute clean-down.
          { employeeId: 'e1', workWindows: [span(9, 18)], busy: [{ start: at(10), end: at(11, 15) }] },
        ],
      });
      const hours = startHours(input);
      expect(hours).not.toContain(11); // reserved 11:00–12:15 hits busy 10:00–11:15
      expect(hours).toContain(11.5); // reserved 11:30–12:45 is clear
    });
  });

  describe('scenario 5 — one employee unavailable, another free', () => {
    it('keeps the slot and narrows the candidate list', () => {
      const input = baseInput({
        slotIntervalMs: 60 * M,
        requiresEmployee: true,
        employees: [
          { employeeId: 'e1', workWindows: [span(9, 18)], busy: [span(14, 16)] }, // time off
          { employeeId: 'e2', workWindows: [span(9, 18)], busy: [] },
        ],
      });
      const slots = computeAvailability(input);
      const two = slots.find((s) => s.startAt === at(10))!;
      const one = slots.find((s) => s.startAt === at(14))!;
      expect(two.employeeIds).toEqual(['e1', 'e2']); // sorted, deterministic
      expect(one.employeeIds).toEqual(['e2']);
    });
  });

  describe('scenario 6 — resource pool', () => {
    const withPool = (quantity: number): AvailabilityEngineInput =>
      baseInput({
        slotIntervalMs: 60 * M,
        requiresResource: true,
        resourceRequirements: [
          {
            resourceTypeId: 'room',
            quantity,
            pool: [
              { resourceId: 'r1', busy: [span(10, 11)] },
              { resourceId: 'r2', busy: [] },
            ],
          },
        ],
      });

    it('stays available while any resource in the pool is free', () => {
      const slots = computeAvailability(withPool(1));
      const contested = slots.find((s) => s.startAt === at(10))!;
      const free = slots.find((s) => s.startAt === at(12))!;
      expect(contested.resourceIds).toEqual(['r2']);
      expect(free.resourceIds).toEqual(['r1', 'r2']);
    });

    it('drops the slot when the pool cannot meet the quantity', () => {
      const hours = startHours(withPool(2));
      expect(hours).not.toContain(10); // only r2 is free at 10:00, need 2
      expect(hours).toContain(12);
    });
  });

  describe('scenario 7 — branch closed', () => {
    it('returns nothing without inspecting staff or resources', () => {
      expect(computeAvailability(baseInput({ businessWindows: [] }))).toEqual([]);
    });
  });

  describe('service bookability windows', () => {
    it('narrows the branch hours', () => {
      const input = baseInput({ slotIntervalMs: 60 * M, serviceWindows: [span(9, 12)] });
      expect(startHours(input)).toEqual([9, 10, 11]);
    });
  });

  describe('booking lead time', () => {
    it('drops candidates before the earliest allowed start', () => {
      const input = baseInput({ slotIntervalMs: 30 * M, earliestStart: at(11, 15) });
      expect(startHours(input)[0]).toBe(11.5);
    });
  });

  describe('buffers may spill past closing time', () => {
    it('accepts a last slot whose clean-down runs past close', () => {
      const input = baseInput({ slotIntervalMs: 60 * M, bufferAfterMs: 30 * M });
      const hours = startHours(input);
      expect(hours).toContain(17); // appt 17:00–18:00 fits; buffer to 18:30 is allowed
      expect(hours).not.toContain(18); // appt would end 19:00, past close
    });
  });

  describe('structural short-circuits', () => {
    it('returns nothing when the service needs staff and none are eligible', () => {
      expect(computeAvailability(baseInput({ requiresEmployee: true, employees: [] }))).toEqual([]);
    });

    it('returns nothing when a required resource group has an empty pool', () => {
      const input = baseInput({
        requiresResource: true,
        resourceRequirements: [{ resourceTypeId: 'room', quantity: 1, pool: [] }],
      });
      expect(computeAvailability(input)).toEqual([]);
    });
  });
});
