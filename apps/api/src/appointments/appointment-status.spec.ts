import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppointmentStatus } from '@prisma/client';
import { SlotTakenError } from '../common/errors';
import {
  RESCHEDULABLE,
  TRANSITIONS,
  blocksCalendar,
  canTransition,
  isTerminal,
  sourcesOf,
  timestampFor,
} from './appointment-status';
import { asSlotTaken } from './appointments.service';

const ALL = Object.keys(TRANSITIONS) as AppointmentStatus[];

describe('appointment status graph', () => {
  it('walks the happy path one step at a time', () => {
    expect(canTransition('PENDING', 'CONFIRMED')).toBe(true);
    expect(canTransition('CONFIRMED', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('IN_PROGRESS', 'COMPLETED')).toBe(true);
  });

  it('refuses skipping steps and going backwards', () => {
    expect(canTransition('PENDING', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('PENDING', 'COMPLETED')).toBe(false);
    expect(canTransition('CONFIRMED', 'COMPLETED')).toBe(false);
    expect(canTransition('IN_PROGRESS', 'CONFIRMED')).toBe(false);
    expect(canTransition('CONFIRMED', 'PENDING')).toBe(false);
  });

  it('never leaves a terminal state', () => {
    for (const terminal of ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED'] as const) {
      expect(isTerminal(terminal)).toBe(true);
      for (const to of ALL) expect(canTransition(terminal, to)).toBe(false);
    }
  });

  it('allows cancellation from every live state', () => {
    for (const from of ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'] as const) {
      expect(canTransition(from, 'CANCELLED')).toBe(true);
    }
  });

  it('allows a no-show only before the service has started', () => {
    expect(sourcesOf('NO_SHOW').sort()).toEqual(['CHECKED_IN', 'CONFIRMED', 'PENDING']);
    expect(canTransition('IN_PROGRESS', 'NO_SHOW')).toBe(false);
  });

  it('only reschedules appointments that have not started', () => {
    expect([...RESCHEDULABLE].sort()).toEqual(['CHECKED_IN', 'CONFIRMED', 'PENDING']);
  });

  it('stamps the matching timestamp column', () => {
    expect(timestampFor('CONFIRMED')).toBe('confirmedAt');
    expect(timestampFor('CANCELLED')).toBe('cancelledAt');
    expect(timestampFor('NO_SHOW')).toBe('noShowAt');
    expect(timestampFor('COMPLETED')).toBe('completedAt');
    expect(timestampFor('IN_PROGRESS')).toBeNull();
  });
});

describe('blocksCalendar', () => {
  it('matches the sync_blocks_calendar() trigger in 001_hardening.sql exactly', () => {
    // appointment_resource has no trigger, so the application writes this flag
    // itself. If the two lists ever drift, a cancelled booking keeps its room.
    const sql = readFileSync(join(__dirname, '../../prisma/sql/001_hardening.sql'), 'utf8');
    const match = /NEW\.status IN \(([^)]*)\)/.exec(
      sql.slice(sql.indexOf('FUNCTION sync_blocks_calendar')),
    );
    expect(match).not.toBeNull();
    const fromSql = match![1]!
      .split(',')
      .map((s) => s.trim().replace(/'/g, ''))
      .sort();

    expect(ALL.filter(blocksCalendar).sort()).toEqual(fromSql);
  });
});

describe('asSlotTaken', () => {
  const pgError = (constraint: string) =>
    new Error(
      `Error occurred during query execution: ConnectorError(... PostgresError { code: "23P01", ` +
        `message: "conflicting key value violates exclusion constraint \\"${constraint}\\"" ...`,
    );

  it('maps the employee exclusion constraint', () => {
    const mapped = asSlotTaken(pgError('appointment_item_employee_no_overlap'));
    expect(mapped).toBeInstanceOf(SlotTakenError);
    expect(mapped!.details).toEqual({ conflict: 'employee' });
  });

  it('maps the resource exclusion constraint', () => {
    expect(asSlotTaken(pgError('appointment_resource_no_overlap'))!.details).toEqual({
      conflict: 'resource',
    });
  });

  it('leaves unrelated errors alone', () => {
    expect(asSlotTaken(new Error('connection reset'))).toBeNull();
    expect(asSlotTaken(pgError('some_future_constraint'))).toBeNull();
  });
});
