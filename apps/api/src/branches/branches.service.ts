import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ConflictError, ResourceNotFoundError, ValidationFailedError } from '../common/errors';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import { BranchRepository } from './branch.repository';
import type {
  CreateBranchDto,
  ListBranchesDto,
  PutBusinessHoursDto,
  UpdateBranchDto,
  UpdateBranchSettingsDto,
} from './dto/branch.dto';
import { EntitlementsService } from '../subscriptions/entitlements.service';

/**
 * Branches, and the two things hanging off them: per-branch policy overrides
 * and weekly opening hours.
 *
 * ---------------------------------------------------------------------------
 * EVERY QUERY IS TENANT-SCOPED, AND NOT BY CONVENTION
 * ---------------------------------------------------------------------------
 *
 * Reads and single-row writes go through BranchRepository, which merges the
 * company from the request context into every filter. The multi-table
 * operations below open a transaction with `repository.transaction()`, which
 * hands back the company id — so even hand-written queries in here take it from
 * the context rather than from anything a caller sent.
 *
 * Under that, RLS refuses the rows anyway, and the composite foreign key
 * `(company_id, branch_id)` makes a settings row or an opening-hours row
 * pointing at another tenant's branch structurally unrepresentable.
 */
@Injectable()
export class BranchesService {
  private readonly logger = new Logger(BranchesService.name);

  constructor(
    private readonly branches: BranchRepository,
    private readonly db: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  async list(query: ListBranchesDto) {
    return this.branches.transaction(async (tx, companyId) => {
      const where = {
        companyId,
        deletedAt: null,
        ...(query.status === 'all' ? {} : { status: query.status }),
      };

      const [rows, total] = await Promise.all([
        tx.branch.findMany({
          where,
          // Deliberate ordering: `sortOrder` is what a company arranges its own
          // branch list by, and name is the tie-break so the output is stable
          // rather than whatever the planner returns.
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          skip: query.offset,
          take: query.limit,
        }),
        tx.branch.count({ where }),
      ]);

      return { items: rows.map(toBranchResponse), total };
    });
  }

  async findById(branchId: string) {
    const branch = await this.branches.findFirst({ id: branchId, deletedAt: null });
    if (!branch) throw new ResourceNotFoundError('Branch', branchId);
    return toBranchResponse(branch);
  }

  async create(input: CreateBranchDto) {
    const created = await this.branches.transaction(async (tx, companyId) => {
      await assertTimezoneExists(tx, input.timezoneName);
      if (input.currencyCode) await assertCurrencyExists(tx, input.currencyCode);
      await this.assertCodeAvailable(tx, companyId, input.code);
      // The plan's branch limit (and MULTI_BRANCH), counted under a lock.
      await this.entitlements.assertCanAdd(tx, companyId, 'BRANCH');

      try {
        return await tx.branch.create({
          data: { ...input, companyId, ...toDecimals(input) },
        });
      } catch (error) {
        // The check above is a check-then-act; two concurrent creates with the
        // same code both pass it and one loses at the partial unique index.
        // Same 409 either way, so the race is indistinguishable.
        throw mapDuplicateCode(error, input.code);
      }
    });

    await this.audit.record({
      action: 'branch.created',
      resourceType: 'branch',
      resourceId: created.id,
      after: { code: created.code, name: created.name, timezoneName: created.timezoneName },
    });

    this.logger.log(`Branch ${created.code} created for company ${created.companyId}`);

    return toBranchResponse(created);
  }

  async update(branchId: string, input: UpdateBranchDto) {
    const { before, after } = await this.branches.transaction(async (tx, companyId) => {
      const before = await tx.branch.findFirst({
        where: { id: branchId, companyId, deletedAt: null },
      });
      if (!before) throw new ResourceNotFoundError('Branch', branchId);

      if (input.timezoneName && input.timezoneName !== before.timezoneName) {
        await assertTimezoneExists(tx, input.timezoneName);
      }
      if (input.currencyCode) await assertCurrencyExists(tx, input.currencyCode);
      if (input.code && input.code !== before.code) {
        await this.assertCodeAvailable(tx, companyId, input.code, branchId);
      }

      try {
        // updateMany + re-read rather than `update`: a where-unique that matches
        // another tenant throws a P2025 whose message differs from a genuine
        // miss, which is an existence oracle. A count of zero looks identical
        // either way.
        const { count } = await tx.branch.updateMany({
          where: { id: branchId, companyId, deletedAt: null },
          data: { ...input, ...toDecimals(input) },
        });
        if (count === 0) throw new ResourceNotFoundError('Branch', branchId);
      } catch (error) {
        throw mapDuplicateCode(error, input.code ?? before.code);
      }

      const after = await tx.branch.findFirstOrThrow({ where: { id: branchId, companyId } });
      return { before, after };
    });

    await this.audit.record({
      action: 'branch.updated',
      resourceType: 'branch',
      resourceId: branchId,
      before: auditableBranch(before),
      after: auditableBranch(after),
    });

    return toBranchResponse(after);
  }

  /**
   * Soft delete.
   *
   * A branch is referenced by appointments, payments and gift cards. Removing
   * the row would either fail on a foreign key or, worse, cascade through
   * history — so it is marked deleted and disappears from every list, while the
   * bookings that happened there keep resolving.
   *
   * The partial unique index is `WHERE deleted_at IS NULL`, so deleting also
   * releases the code for reuse. That is intended: a company that closes `HQ`
   * and opens a new one should be able to call it `HQ`.
   */
  async remove(branchId: string) {
    const before = await this.branches.transaction(async (tx, companyId) => {
      const before = await tx.branch.findFirst({
        where: { id: branchId, companyId, deletedAt: null },
      });
      if (!before) throw new ResourceNotFoundError('Branch', branchId);

      await tx.branch.updateMany({
        where: { id: branchId, companyId, deletedAt: null },
        data: { deletedAt: new Date(), status: 'INACTIVE' },
      });

      return before;
    });

    await this.audit.record({
      action: 'branch.deactivated',
      resourceType: 'branch',
      resourceId: branchId,
      before: auditableBranch(before),
    });
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  async findSettings(branchId: string) {
    return this.branches.transaction(async (tx, companyId) => {
      await this.assertBranchExists(tx, companyId, branchId);

      const settings = await tx.branchSettings.findFirst({ where: { companyId, branchId } });

      // Null throughout means "inherit the company", which is the correct
      // answer for a branch nobody has configured — not an error, and not the
      // company's values copied in, because a copy would stop tracking.
      return settings ? toBranchSettingsResponse(settings) : EMPTY_BRANCH_SETTINGS;
    });
  }

  async updateSettings(branchId: string, input: UpdateBranchSettingsDto) {
    const after = await this.branches.transaction(async (tx, companyId) => {
      await this.assertBranchExists(tx, companyId, branchId);

      // The COMPOSITE unique, not the bare `branchId` primary key. The Prisma
      // guard extension refuses a filter on a company-owned model that carries
      // no companyId, and it is right to: `where: { branchId }` alone would be
      // a lookup by an id the caller supplied, with nothing tying it to the
      // tenant.
      return tx.branchSettings.upsert({
        where: { companyId_branchId: { companyId, branchId } },
        create: { branchId, companyId, ...input },
        update: input,
      });
    });

    await this.audit.record({
      action: 'branch.settings_updated',
      resourceType: 'branch_settings',
      resourceId: branchId,
      after: toBranchSettingsResponse(after),
    });

    return toBranchSettingsResponse(after);
  }

  // ---------------------------------------------------------------------------
  // Business hours
  // ---------------------------------------------------------------------------

  async findBusinessHours(branchId: string) {
    return this.branches.transaction(async (tx, companyId) => {
      await this.assertBranchExists(tx, companyId, branchId);

      const rows = await tx.businessHours.findMany({
        where: { companyId, branchId },
        orderBy: [{ effectiveFrom: 'desc' }, { dayOfWeek: 'asc' }],
      });

      // Only the newest version of each day. The table is versioned by
      // `effectiveFrom` so summer hours can be set in advance, but "what are
      // the hours" means the current set.
      const latest = new Map<number, (typeof rows)[number]>();
      for (const row of rows) {
        if (!latest.has(row.dayOfWeek)) latest.set(row.dayOfWeek, row);
      }

      return {
        days: [...latest.values()]
          .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
          .map(toBusinessHoursResponse),
      };
    });
  }

  /**
   * Replace the week.
   *
   * A PUT, and it rewrites every day in one transaction. Opening hours are read
   * as a set — "Tuesday to Saturday" is one decision — and applying it as seven
   * independent edits would leave windows where the schedule is half old and
   * half new, which a future availability engine would happily materialise.
   *
   * Days omitted from the request are recorded as CLOSED rather than left
   * alone. Silence about Sunday means closed on Sunday; carrying the previous
   * value forward would make the result depend on history nobody can see.
   */
  async putBusinessHours(branchId: string, input: PutBusinessHoursDto) {
    const effectiveFrom = new Date(`${input.effectiveFrom ?? today()}T00:00:00.000Z`);

    const days = await this.branches.transaction(async (tx, companyId) => {
      await this.assertBranchExists(tx, companyId, branchId);

      // Replace this version wholesale. Scoped to the effectiveFrom being
      // written, so a future-dated set is not destroyed by an edit to today's.
      await tx.businessHours.deleteMany({ where: { companyId, branchId, effectiveFrom } });

      const supplied = new Map(input.days.map((d) => [d.dayOfWeek, d]));

      await tx.businessHours.createMany({
        data: Array.from({ length: 7 }, (_, dayOfWeek) => {
          const day = supplied.get(dayOfWeek);
          const closed = !day || day.isClosed;

          return {
            companyId,
            branchId,
            dayOfWeek,
            isClosed: closed,
            // `@db.Time(0)` — Prisma takes a Date and keeps the time part. The
            // date component is arbitrary and never read.
            opensAt: closed ? null : new Date(`1970-01-01T${day.opensAt}:00.000Z`),
            closesAt: closed ? null : new Date(`1970-01-01T${day.closesAt}:00.000Z`),
            effectiveFrom,
            // `crossesMidnight` is deliberately not set here: a trigger derives
            // it from the times, so the flag cannot disagree with them.
          };
        }),
      });

      return tx.businessHours.findMany({
        where: { companyId, branchId, effectiveFrom },
        orderBy: { dayOfWeek: 'asc' },
      });
    });

    await this.audit.record({
      action: 'branch.business_hours_updated',
      resourceType: 'business_hours',
      resourceId: branchId,
      after: { effectiveFrom, days: days.map(toBusinessHoursResponse) },
    });

    return { days: days.map(toBusinessHoursResponse) };
  }

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  /**
   * The branch belongs to this company, or it does not exist.
   *
   * Called before every settings and hours operation. Without it those would
   * write a row keyed by a branch id the caller does not own — the composite
   * foreign key would refuse it, but as a 500 rather than the 404 that keeps
   * another tenant's branch ids unguessable.
   */
  private async assertBranchExists(tx: TenantTx, companyId: string, branchId: string) {
    const branch = await tx.branch.findFirst({
      where: { id: branchId, companyId, deletedAt: null },
      select: { id: true },
    });

    if (!branch) throw new ResourceNotFoundError('Branch', branchId);
  }

  private async assertCodeAvailable(
    tx: TenantTx,
    companyId: string,
    code: string,
    exceptBranchId?: string,
  ) {
    const clash = await tx.branch.findFirst({
      where: {
        companyId,
        code,
        deletedAt: null,
        ...(exceptBranchId ? { id: { not: exceptBranchId } } : {}),
      },
      select: { id: true },
    });

    if (clash) {
      throw new ConflictError(`Another branch already uses the code "${code}".`, {
        field: 'code',
        branchId: clash.id,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BranchRecord {
  id: string;
  companyId: string;
  code: string;
  name: string;
  status: string;
  timezoneName: string;
  currencyCode: string | null;
  phone?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  district?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  latitude?: Prisma.Decimal | null;
  longitude?: Prisma.Decimal | null;
  sortOrder: number;
  createdAt?: Date;
  updatedAt?: Date;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Hand the decimal columns to Prisma as Decimal, not as numbers.
 *
 * The DTO carries them as strings precisely so they never pass through a float;
 * this is where that string becomes a fixed-precision value.
 */
function toDecimals(input: { latitude?: string | null; longitude?: string | null }) {
  const out: { latitude?: Prisma.Decimal | null; longitude?: Prisma.Decimal | null } = {};
  if (input.latitude !== undefined) {
    out.latitude = input.latitude === null ? null : new Prisma.Decimal(input.latitude);
  }
  if (input.longitude !== undefined) {
    out.longitude = input.longitude === null ? null : new Prisma.Decimal(input.longitude);
  }
  return out;
}

async function assertTimezoneExists(tx: TenantTx, name: string): Promise<void> {
  const timezone = await tx.timezone.findUnique({ where: { name } });
  if (!timezone) throw new ValidationFailedError({ timezoneName: 'Unknown IANA timezone.' });
}

async function assertCurrencyExists(tx: TenantTx, code: string): Promise<void> {
  const currency = await tx.currency.findUnique({ where: { code } });
  if (!currency) throw new ValidationFailedError({ currencyCode: 'Unknown currency code.' });
}

/** Map the partial unique index violation to the same 409 as the pre-check. */
function mapDuplicateCode(error: unknown, code: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictError(`Another branch already uses the code "${code}".`, { field: 'code' });
  }
  return error;
}

function toBranchResponse(branch: BranchRecord) {
  return {
    id: branch.id,
    code: branch.code,
    name: branch.name,
    status: branch.status,
    timezoneName: branch.timezoneName,
    currencyCode: branch.currencyCode,
    phone: branch.phone ?? null,
    email: branch.email ?? null,
    addressLine1: branch.addressLine1 ?? null,
    addressLine2: branch.addressLine2 ?? null,
    city: branch.city ?? null,
    district: branch.district ?? null,
    postalCode: branch.postalCode ?? null,
    countryCode: branch.countryCode ?? null,
    // Decimal -> string, never a number: a JS number cannot hold six decimal
    // places of longitude without rounding, and the column exists to avoid
    // exactly that.
    latitude: branch.latitude?.toString() ?? null,
    longitude: branch.longitude?.toString() ?? null,
    sortOrder: branch.sortOrder,
    createdAt: branch.createdAt,
    updatedAt: branch.updatedAt,
    // `companyId` is omitted: the caller is already scoped to it, and echoing a
    // tenant key invites a client to start passing it back.
  };
}

function auditableBranch(branch: BranchRecord) {
  return {
    code: branch.code,
    name: branch.name,
    status: branch.status,
    timezoneName: branch.timezoneName,
    city: branch.city ?? null,
  };
}

function toBranchSettingsResponse(s: {
  slotGranularityMin: number | null;
  bookingLeadTimeMin: number | null;
  maxAdvanceBookingDays: number | null;
  cancellationWindowHours: number | null;
  allowOnlineBooking: boolean | null;
  requireDeposit: boolean | null;
  depositPercentBps: number | null;
}) {
  return {
    slotGranularityMin: s.slotGranularityMin,
    bookingLeadTimeMin: s.bookingLeadTimeMin,
    maxAdvanceBookingDays: s.maxAdvanceBookingDays,
    cancellationWindowHours: s.cancellationWindowHours,
    allowOnlineBooking: s.allowOnlineBooking,
    requireDeposit: s.requireDeposit,
    depositPercentBps: s.depositPercentBps,
  };
}

/** Every override unset: this branch follows the company. */
const EMPTY_BRANCH_SETTINGS = {
  slotGranularityMin: null,
  bookingLeadTimeMin: null,
  maxAdvanceBookingDays: null,
  cancellationWindowHours: null,
  allowOnlineBooking: null,
  requireDeposit: null,
  depositPercentBps: null,
};

function toBusinessHoursResponse(row: {
  dayOfWeek: number;
  isClosed: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
  crossesMidnight: boolean;
  effectiveFrom: Date;
}) {
  return {
    dayOfWeek: row.dayOfWeek,
    isClosed: row.isClosed,
    opensAt: row.opensAt ? toHhMm(row.opensAt) : null,
    closesAt: row.closesAt ? toHhMm(row.closesAt) : null,
    /** Derived by a database trigger, never sent by a client. */
    crossesMidnight: row.crossesMidnight,
    effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
  };
}

/** `@db.Time` comes back as a Date on 1970-01-01; only the time part matters. */
function toHhMm(value: Date): string {
  return value.toISOString().slice(11, 16);
}
