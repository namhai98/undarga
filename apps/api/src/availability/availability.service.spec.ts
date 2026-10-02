import { ServiceNotBookableError, ValidationFailedError } from '../common/errors';
import { parsePlainDate, weekdayOf } from '../common/time';
import { AvailabilityService } from './availability.service';
import type {
  AvailabilityRepository,
  ResolvedBranchRow,
  ResolvedDay,
  ResolvedServiceRow,
} from './availability.repository';

const TZ = 'Asia/Ulaanbaatar'; // fixed +08:00, no DST — keeps assertions stable
const DATE = '2026-10-06';
const WEEKDAY = weekdayOf(parsePlainDate(DATE));

function time(hhmm: string): Date {
  return new Date(`1970-01-01T${hhmm}:00.000Z`);
}

function makeBranch(overrides: Partial<ResolvedBranchRow> = {}): ResolvedBranchRow {
  return { id: 'branch-1', timezoneName: TZ, status: 'ACTIVE', ...overrides };
}

function makeService(overrides: Partial<ResolvedServiceRow> = {}): ResolvedServiceRow {
  return {
    id: 'service-1',
    status: 'ACTIVE',
    durationMin: 60,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    requiresEmployee: false,
    requiresResource: false,
    isOnlineBookable: true,
    ...overrides,
  };
}

function makeDay(overrides: Partial<ResolvedDay> = {}): ResolvedDay {
  return {
    serviceBranch: { isAvailable: true, durationOverrideMin: null },
    companySettings: {
      slotGranularityMin: 30,
      bookingLeadTimeMin: 0,
      maxAdvanceBookingDays: 400,
    },
    branchSettings: null,
    businessHours: [
      {
        dayOfWeek: WEEKDAY,
        isClosed: false,
        opensAt: time('09:00'),
        closesAt: time('17:00'),
        crossesMidnight: false,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    closures: [],
    serviceRules: [],
    employeeIds: [],
    schedules: [],
    exceptions: [],
    timeOff: [],
    appointmentItems: [],
    requirements: [],
    resources: [],
    resourceReservations: [],
    ...overrides,
  };
}

function createService(repo: Partial<AvailabilityRepository>, cacheEnabled = false) {
  const redis = {
    tenantKey: jest.fn(() => 't:key'),
    getJson: jest.fn(),
    setJson: jest.fn(),
  };
  const config = {
    availability: { cacheEnabled, cacheTtlSeconds: cacheEnabled ? 15 : 0 },
  };
  const service = new AvailabilityService(
    repo as AvailabilityRepository,
    redis as never,
    config as never,
  );
  return { service, redis };
}

const query = (overrides: Record<string, string> = {}) => ({
  branchId: 'branch-1',
  serviceId: 'service-1',
  date: DATE,
  ...overrides,
});

describe('AvailabilityService', () => {
  it('rejects a date that is not a real calendar day', async () => {
    const { service } = createService({
      loadBranch: jest.fn().mockResolvedValue(makeBranch()),
      loadService: jest.fn().mockResolvedValue(makeService()),
    });
    await expect(service.getDay(query({ date: '2026-02-30' }))).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('throws SERVICE_NOT_BOOKABLE for a non-ACTIVE service', async () => {
    const { service } = createService({
      loadBranch: jest.fn().mockResolvedValue(makeBranch()),
      loadService: jest.fn().mockResolvedValue(makeService({ status: 'DRAFT' })),
    });
    await expect(service.getDay(query())).rejects.toBeInstanceOf(ServiceNotBookableError);
  });

  it('returns an empty day with DATE_IN_PAST for a past date', async () => {
    const { service } = createService({
      loadBranch: jest.fn().mockResolvedValue(makeBranch()),
      loadService: jest.fn().mockResolvedValue(makeService()),
      loadDay: jest.fn(),
    });
    const result = await service.getDay(query({ date: '2020-01-01' }));
    expect(result.slots).toEqual([]);
    expect(result.unavailableReason).toBe('DATE_IN_PAST');
  });

  it('reports BRANCH_CLOSED when there are no business hours for the day', async () => {
    const { service } = createService({
      loadBranch: jest.fn().mockResolvedValue(makeBranch()),
      loadService: jest.fn().mockResolvedValue(makeService()),
      loadDay: jest.fn().mockResolvedValue(makeDay({ businessHours: [] })),
    });
    const result = await service.getDay(query());
    expect(result.slots).toEqual([]);
    expect(result.unavailableReason).toBe('BRANCH_CLOSED');
  });

  it('reports SERVICE_NOT_OFFERED_AT_BRANCH when the service has no branch row', async () => {
    const { service } = createService({
      loadBranch: jest.fn().mockResolvedValue(makeBranch()),
      loadService: jest.fn().mockResolvedValue(makeService()),
      loadDay: jest.fn().mockResolvedValue(makeDay({ serviceBranch: null })),
    });
    const result = await service.getDay(query());
    expect(result.unavailableReason).toBe('SERVICE_NOT_OFFERED_AT_BRANCH');
  });

  it('computes slots in the branch timezone with ISO offsets', async () => {
    const { service, redis } = createService({
      loadBranch: jest.fn().mockResolvedValue(makeBranch()),
      loadService: jest.fn().mockResolvedValue(makeService()),
      loadDay: jest.fn().mockResolvedValue(makeDay()),
    });

    const result = await service.getDay(query());

    expect(result.timezone).toBe(TZ);
    expect(result.slotIntervalMin).toBe(30);
    expect(result.serviceDurationMin).toBe(60);
    expect(result.unavailableReason).toBeNull();
    // 09:00 .. 16:00 on a 30-minute grid, last service ending at 17:00.
    expect(result.slots[0]!.startAt).toBe('2026-10-06T09:00:00+08:00');
    expect(result.slots[0]!.endAt).toBe('2026-10-06T10:00:00+08:00');
    expect(result.slots[result.slots.length - 1]!.startAt).toBe('2026-10-06T16:00:00+08:00');
    expect(result.slots.every((s) => s.available)).toBe(true);
    // Cache disabled — Redis is never consulted.
    expect(redis.getJson).not.toHaveBeenCalled();
    expect(redis.setJson).not.toHaveBeenCalled();
  });

  it('reads and writes the advisory cache when it is enabled', async () => {
    const day = makeDay();
    const { service, redis } = createService(
      {
        loadBranch: jest.fn().mockResolvedValue(makeBranch()),
        loadService: jest.fn().mockResolvedValue(makeService()),
        loadDay: jest.fn().mockResolvedValue(day),
      },
      true,
    );

    redis.getJson.mockResolvedValueOnce(null);
    const first = await service.getDay(query());
    expect(redis.getJson).toHaveBeenCalledTimes(1);
    expect(redis.setJson).toHaveBeenCalledWith('t:key', first, 15);

    redis.getJson.mockResolvedValueOnce(first);
    const second = await service.getDay(query());
    expect(second).toEqual(first);
  });

  it('excludes an employee on partial time off but keeps the slot for a free colleague', async () => {
    const day = makeDay({
      employeeIds: ['emp-a', 'emp-b'],
      schedules: [
        makeSchedule('emp-a'),
        makeSchedule('emp-b'),
      ],
      // emp-a is off 14:00–16:00 local (+08:00).
      timeOff: [
        {
          employeeId: 'emp-a',
          startsAt: new Date('2026-10-06T06:00:00.000Z'),
          endsAt: new Date('2026-10-06T08:00:00.000Z'),
        },
      ],
    });
    const { service } = createService({
      loadBranch: jest.fn().mockResolvedValue(makeBranch()),
      loadService: jest.fn().mockResolvedValue(makeService({ requiresEmployee: true })),
      loadDay: jest.fn().mockResolvedValue(day),
    });

    const result = await service.getDay(query());
    const twoPm = result.slots.find((s) => s.startAt === '2026-10-06T14:00:00+08:00')!;
    const tenAm = result.slots.find((s) => s.startAt === '2026-10-06T10:00:00+08:00')!;
    expect(twoPm.employeeIds).toEqual(['emp-b']);
    expect(tenAm.employeeIds).toEqual(['emp-a', 'emp-b']);
  });
});

function makeSchedule(employeeId: string): ResolvedDay['schedules'][number] {
  return {
    employeeId,
    dayOfWeek: WEEKDAY,
    startsAt: time('09:00'),
    endsAt: time('17:00'),
    crossesMidnight: false,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    breaks: [],
  };
}
