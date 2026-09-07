import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { IdentityRepository } from '../auth/identity.repository';
import {
  AlreadyAssignedError,
  ConflictError,
  ResourceNotFoundError,
} from '../common/errors';
import { InvitationsService } from '../members/invitations.service';
import type { TenantTx } from '../database/tenant-prisma.service';
import { EmployeeRepository } from './employee.repository';
import type {
  AssignBranchDto,
  AssignServiceDto,
  CreateEmployeeDto,
  EmployeeQueryDto,
  LinkEmployeeAccountDto,
  UpdateEmployeeDto,
} from './dto/employee.dto';

/**
 * Employees: the people a company books work against.
 *
 * ===========================================================================
 * EMPLOYEE IS NOT USER
 * ===========================================================================
 *
 * A `user_account` is a login. An `employee` is somebody a customer can book.
 * Most salons have people in exactly one of those sets: a stylist who never
 * touches the dashboard, and a bookkeeper who never appears on a booking page.
 * So the link is optional in both directions, and `userAccountId` is nullable.
 *
 * Where they overlap, the source of truth is split deliberately:
 *
 *   displayName   EMPLOYEE. What a calendar and a booking page show, which is
 *                 frequently not a legal name — a stage name, a mononym, a
 *                 transliteration. It must be editable without touching the
 *                 person's account, and it survives unlinking.
 *   email         USER ACCOUNT. There is no email column on `employee`, on
 *                 purpose: two copies of an address is two things to keep in
 *                 step, and the one that matters is the one you sign in with.
 *                 An unlinked employee simply has no email.
 *   phone         EMPLOYEE PROFILE. This is the work number a colleague rings,
 *                 which is genuinely a different fact from the personal number
 *                 on the account.
 *   avatar        EMPLOYEE PROFILE (`avatarFileId`). A booking-page portrait is
 *                 not the same picture as a dashboard avatar.
 *
 * ===========================================================================
 * WHAT THE STATUSES MEAN
 * ===========================================================================
 *
 *   ACTIVE      working, and offered slots if `isBookable`.
 *   ON_LEAVE    still employed, temporarily not offered slots. Distinct from
 *               INACTIVE because reporting should still count them as staff.
 *   INACTIVE    not working, not offered slots, record retained.
 *   TERMINATED  employment ended. Historical records stay intact.
 *
 * `isBookable` is a SEPARATE axis and both are needed: a manager may be ACTIVE
 * and never bookable, and a stylist may be temporarily un-bookable without any
 * change to their employment. The availability engine will read both; nothing
 * reads them yet.
 */
@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private readonly employees: EmployeeRepository,
    private readonly identity: IdentityRepository,
    private readonly invitations: InvitationsService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * Filtered, searched and paginated — in the DATABASE.
   *
   * Every predicate below becomes SQL. Loading a company's staff into memory to
   * filter them would work fine for a salon with six people and fall over for a
   * chain with six hundred, which is exactly the customer worth keeping.
   *
   * The branch and service filters go through the join tables with `some`,
   * which is the same shape as the question the availability engine will
   * eventually ask — "who can do this, here?" — so the indexes that make this
   * fast are the ones it will need.
   */
  async list(query: EmployeeQueryDto) {
    return this.employees.transaction(async (tx, companyId) => {
      const where: Prisma.EmployeeWhereInput = {
        companyId,
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.isBookable ? { isBookable: query.isBookable === 'true' } : {}),
        ...(query.hasAccount
          ? query.hasAccount === 'true'
            ? { userAccountId: { not: null } }
            : { userAccountId: null }
          : {}),
        ...(query.branchId ? { branches: { some: { companyId, branchId: query.branchId } } } : {}),
        ...(query.serviceId
          ? { services: { some: { companyId, serviceId: query.serviceId } } }
          : {}),
        /**
         * Name, code and work phone.
         *
         * Email is deliberately NOT searchable. It lives on `user_account`,
         * which the tenant connection can only see through the membership RLS
         * policy — so the same query would match for a colleague who has
         * accepted their invitation and silently miss one who has not. A search
         * whose results depend on somebody else's onboarding state is worse
         * than one that never claimed to cover the field.
         */
        ...(query.search
          ? {
              OR: [
                { displayName: { contains: query.search, mode: 'insensitive' } },
                { employeeCode: { contains: query.search, mode: 'insensitive' } },
                { profile: { phone: { contains: query.search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        tx.employee.findMany({
          where,
          orderBy: { [query.sortBy]: query.sortOrder },
          skip: query.offset,
          take: query.limit,
          include: {
            profile: true,
            branches: { select: { branchId: true, isPrimary: true } },
            userAccount: { select: { id: true, email: true, status: true } },
          },
        }),
        tx.employee.count({ where }),
      ]);

      return { items: rows.map(toEmployeeResponse), total, limit: query.limit, offset: query.offset };
    });
  }

  async findById(employeeId: string) {
    return this.employees.transaction(async (tx, companyId) => {
      const employee = await tx.employee.findFirst({
        where: { id: employeeId, companyId, deletedAt: null },
        include: {
          profile: true,
          branches: {
            select: { branchId: true, isPrimary: true, branch: { select: { name: true, code: true } } },
          },
          services: {
            select: {
              serviceId: true,
              durationOverrideMin: true,
              priceOverrideMinor: true,
              proficiency: true,
              service: { select: { name: true, code: true } },
            },
          },
          userAccount: { select: { id: true, email: true, status: true, emailVerifiedAt: true } },
        },
      });

      if (!employee) throw new ResourceNotFoundError('Employee', employeeId);
      return toEmployeeDetailResponse(employee);
    });
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async create(input: CreateEmployeeDto) {
    const { profile, branchIds, hiredOn, ...employee } = input;

    const created = await this.employees.transaction(async (tx, companyId) => {
      if (employee.employeeCode) {
        await this.assertCodeAvailable(tx, companyId, employee.employeeCode);
      }
      // Validated BEFORE the employee row exists, so a bad branch id produces a
      // 404 and no orphan.
      if (branchIds?.length) await this.assertBranchesExist(tx, companyId, branchIds);

      const row = await tx.employee.create({
        data: {
          ...employee,
          companyId,
          hiredOn: hiredOn ? new Date(`${hiredOn}T00:00:00.000Z`) : undefined,
          // `userAccountId` is absent by construction: linking a login has its
          // own endpoint because it also creates a membership and an invitation.
        },
      });

      if (profile) {
        await tx.employeeProfile.create({ data: { employeeId: row.id, companyId, ...profile } });
      }

      if (branchIds?.length) {
        await tx.employeeBranch.createMany({
          data: branchIds.map((branchId, index) => ({
            companyId,
            employeeId: row.id,
            branchId,
            // The first assigned branch is primary, so an employee is never
            // left without one — the schedule engine needs a default place.
            isPrimary: index === 0,
          })),
        });
      }

      return row;
    });

    await this.audit.record({
      action: 'employee.created',
      resourceType: 'employee',
      resourceId: created.id,
      after: {
        displayName: created.displayName,
        employeeCode: created.employeeCode,
        status: created.status,
        branchCount: branchIds?.length ?? 0,
      },
    });

    return this.findById(created.id);
  }

  async update(employeeId: string, input: UpdateEmployeeDto) {
    const { profile, hiredOn, employmentEndedOn, ...employee } = input;

    const before = await this.employees.transaction(async (tx, companyId) => {
      const before = await tx.employee.findFirst({
        where: { id: employeeId, companyId, deletedAt: null },
      });
      if (!before) throw new ResourceNotFoundError('Employee', employeeId);

      if (employee.employeeCode && employee.employeeCode !== before.employeeCode) {
        await this.assertCodeAvailable(tx, companyId, employee.employeeCode, employeeId);
      }

      try {
        // updateMany, not update: a where-unique matching another tenant throws
        // a P2025 whose message differs from a genuine miss, which is an
        // existence oracle. A count of zero looks the same either way.
        const { count } = await tx.employee.updateMany({
          where: { id: employeeId, companyId, deletedAt: null },
          data: {
            ...employee,
            ...(hiredOn !== undefined
              ? { hiredOn: hiredOn ? new Date(`${hiredOn}T00:00:00.000Z`) : null }
              : {}),
            ...(employmentEndedOn !== undefined
              ? {
                  employmentEndedOn: employmentEndedOn
                    ? new Date(`${employmentEndedOn}T00:00:00.000Z`)
                    : null,
                }
              : {}),
          },
        });
        if (count === 0) throw new ResourceNotFoundError('Employee', employeeId);
      } catch (error) {
        throw mapDuplicateCode(error, employee.employeeCode ?? '');
      }

      if (profile) {
        // Upsert on the COMPOSITE unique — the guard extension refuses a filter
        // on a company-owned model that carries no companyId, and it is right
        // to: `where: { employeeId }` alone is a lookup by a caller-supplied id
        // with nothing tying it to the tenant.
        await tx.employeeProfile.upsert({
          where: { companyId_employeeId: { companyId, employeeId } },
          create: { employeeId, companyId, ...profile },
          update: profile,
        });
      }

      return before;
    });

    await this.audit.record({
      action: 'employee.updated',
      resourceType: 'employee',
      resourceId: employeeId,
      before: { displayName: before.displayName, status: before.status, code: before.employeeCode },
      after: { displayName: employee.displayName, status: employee.status },
    });

    return this.findById(employeeId);
  }

  /**
   * Soft delete.
   *
   * An employee is referenced by `appointment_item`, promotions and customer
   * preferences. Removing the row would either fail on a foreign key or cascade
   * through booking history and the revenue attributed to that person — so the
   * record stays, disappears from every list, and stops being bookable.
   *
   * `isBookable: false` alongside the timestamp, so the future availability
   * engine cannot offer a deleted employee even if it forgets to filter on
   * `deletedAt`. Belt and braces on the one mistake that would be visible to
   * customers.
   */
  async remove(employeeId: string) {
    const before = await this.employees.transaction(async (tx, companyId) => {
      const before = await tx.employee.findFirst({
        where: { id: employeeId, companyId, deletedAt: null },
      });
      if (!before) throw new ResourceNotFoundError('Employee', employeeId);

      await tx.employee.updateMany({
        where: { id: employeeId, companyId, deletedAt: null },
        data: { deletedAt: new Date(), status: 'TERMINATED', isBookable: false },
      });

      return before;
    });

    await this.audit.record({
      action: 'employee.deactivated',
      resourceType: 'employee',
      resourceId: employeeId,
      before: { displayName: before.displayName, status: before.status },
    });
  }

  // ---------------------------------------------------------------------------
  // Branch assignment
  // ---------------------------------------------------------------------------

  async listBranches(employeeId: string) {
    return this.employees.transaction(async (tx, companyId) => {
      await this.assertEmployeeExists(tx, companyId, employeeId);

      const rows = await tx.employeeBranch.findMany({
        where: { companyId, employeeId },
        include: { branch: { select: { id: true, code: true, name: true, status: true } } },
        orderBy: { createdAt: 'asc' },
      });

      return {
        items: rows.map((r) => ({
          branchId: r.branchId,
          code: r.branch.code,
          name: r.branch.name,
          status: r.branch.status,
          isPrimary: r.isPrimary,
        })),
      };
    });
  }

  /**
   * `employee.companyId === branch.companyId` is enforced three times over.
   *
   * Here, by looking the branch up with the resolved company in the filter; in
   * the database, by the composite foreign keys `(company_id, employee_id)` and
   * `(company_id, branch_id)` which make a cross-tenant row unrepresentable;
   * and by RLS underneath both. The application check exists so the answer is a
   * 404 rather than a constraint violation.
   */
  async assignBranch(employeeId: string, input: AssignBranchDto) {
    await this.employees.transaction(async (tx, companyId) => {
      await this.assertEmployeeExists(tx, companyId, employeeId);
      await this.assertBranchesExist(tx, companyId, [input.branchId]);

      const existing = await tx.employeeBranch.findFirst({
        where: { companyId, employeeId, branchId: input.branchId },
      });
      if (existing) {
        throw new AlreadyAssignedError('That branch is already assigned to this employee.', {
          field: 'branchId',
        });
      }

      if (input.isPrimary) await this.clearPrimaryBranch(tx, companyId, employeeId);

      // If this is their first branch it becomes primary regardless — an
      // employee with branches but no primary is a state the schedule engine
      // would have to invent a rule for.
      const count = await tx.employeeBranch.count({ where: { companyId, employeeId } });

      await tx.employeeBranch.create({
        data: {
          companyId,
          employeeId,
          branchId: input.branchId,
          isPrimary: input.isPrimary ?? count === 0,
        },
      });
    });

    await this.audit.record({
      action: 'employee.branch_assigned',
      resourceType: 'employee_branch',
      resourceId: employeeId,
      after: { branchId: input.branchId, isPrimary: input.isPrimary ?? false },
    });

    return this.listBranches(employeeId);
  }

  async removeBranch(employeeId: string, branchId: string) {
    await this.employees.transaction(async (tx, companyId) => {
      await this.assertEmployeeExists(tx, companyId, employeeId);

      const { count } = await tx.employeeBranch.deleteMany({
        where: { companyId, employeeId, branchId },
      });
      if (count === 0) throw new ResourceNotFoundError('EmployeeBranch', branchId);

      // Promote another branch rather than leaving the employee primary-less.
      const remaining = await tx.employeeBranch.findFirst({
        where: { companyId, employeeId },
        orderBy: { createdAt: 'asc' },
      });
      if (remaining && !remaining.isPrimary) {
        await tx.employeeBranch.updateMany({
          where: { companyId, employeeId, branchId: remaining.branchId },
          data: { isPrimary: true },
        });
      }
    });

    await this.audit.record({
      action: 'employee.branch_removed',
      resourceType: 'employee_branch',
      resourceId: employeeId,
      before: { branchId },
    });
  }

  // ---------------------------------------------------------------------------
  // Service assignment
  // ---------------------------------------------------------------------------

  async listServices(employeeId: string) {
    return this.employees.transaction(async (tx, companyId) => {
      await this.assertEmployeeExists(tx, companyId, employeeId);

      const rows = await tx.employeeService.findMany({
        where: { companyId, employeeId },
        include: { service: { select: { id: true, code: true, name: true, status: true } } },
      });

      return {
        items: rows.map((r) => ({
          serviceId: r.serviceId,
          code: r.service.code,
          name: r.service.name,
          status: r.service.status,
          durationOverrideMin: r.durationOverrideMin,
          // BigInt as a string — the global serializer does this on the wire,
          // and doing it here keeps the response type honest.
          priceOverrideMinor: r.priceOverrideMinor?.toString() ?? null,
          proficiency: r.proficiency,
        })),
      };
    });
  }

  /**
   * Which services this person performs.
   *
   * The `service` table exists in the schema but nothing creates rows in it
   * yet — Service Management is a separate module. These endpoints are the
   * other half of that many-to-many, built now so the relationship is not
   * bolted on afterwards, and they validate against whatever services exist.
   */
  async assignService(employeeId: string, input: AssignServiceDto) {
    await this.employees.transaction(async (tx, companyId) => {
      await this.assertEmployeeExists(tx, companyId, employeeId);

      const service = await tx.service.findFirst({
        where: { id: input.serviceId, companyId, deletedAt: null },
        select: { id: true },
      });
      if (!service) throw new ResourceNotFoundError('Service', input.serviceId);

      const existing = await tx.employeeService.findFirst({
        where: { companyId, employeeId, serviceId: input.serviceId },
      });
      if (existing) {
        throw new AlreadyAssignedError('That service is already assigned to this employee.', {
          field: 'serviceId',
        });
      }

      await tx.employeeService.create({
        data: {
          companyId,
          employeeId,
          serviceId: input.serviceId,
          durationOverrideMin: input.durationOverrideMin,
          // String -> BigInt here, so the value never passes through a float.
          priceOverrideMinor:
            input.priceOverrideMinor == null ? null : BigInt(input.priceOverrideMinor),
          proficiency: input.proficiency,
        },
      });
    });

    await this.audit.record({
      action: 'employee.service_assigned',
      resourceType: 'employee_service',
      resourceId: employeeId,
      after: { serviceId: input.serviceId },
    });

    return this.listServices(employeeId);
  }

  async removeService(employeeId: string, serviceId: string) {
    await this.employees.transaction(async (tx, companyId) => {
      await this.assertEmployeeExists(tx, companyId, employeeId);

      const { count } = await tx.employeeService.deleteMany({
        where: { companyId, employeeId, serviceId },
      });
      if (count === 0) throw new ResourceNotFoundError('EmployeeService', serviceId);
    });

    await this.audit.record({
      action: 'employee.service_removed',
      resourceType: 'employee_service',
      resourceId: employeeId,
      before: { serviceId },
    });
  }

  // ---------------------------------------------------------------------------
  // Login account
  // ---------------------------------------------------------------------------

  /**
   * Give an employee a way to sign in.
   *
   * Four things happen and they are all somebody else's code: the account comes
   * from `IdentityRepository` (the only place accounts are created), the
   * membership and the invitation come from `InvitationsService`. This method
   * links the employee and orchestrates; it does not reimplement any of it.
   *
   * No password is accepted or generated. The invitee chooses their own when
   * they accept, which is why the response carries a one-time link rather than
   * credentials.
   */
  async linkAccount(employeeId: string, input: LinkEmployeeAccountDto) {
    const employee = await this.employees.findFirst({ id: employeeId, deletedAt: null });
    if (!employee) throw new ResourceNotFoundError('Employee', employeeId);

    if (employee.userAccountId) {
      throw new ConflictError('This employee already has a login. Unlink it first.', {
        field: 'email',
      });
    }

    // Creates the membership and the one-time link, and enforces the
    // privilege-escalation rule — an inviter cannot grant permissions they do
    // not hold. Runs FIRST, so a refused invitation leaves nothing linked.
    const invitation = await this.invitations.create({
      email: input.email,
      roleKeys: input.roleKeys,
    });

    const { account } = await this.identity.findOrCreateInvitedStaffAccount({
      email: input.email,
      fullName: employee.displayName,
    });

    await this.employees.requireUpdateById(employeeId, { userAccountId: account.id });

    await this.audit.record({
      action: 'employee.user_linked',
      resourceType: 'employee',
      resourceId: employeeId,
      after: { userAccountId: account.id, email: input.email, roleKeys: input.roleKeys },
      // The invitation token is deliberately absent. Never put a live
      // credential in an audit payload and rely on redaction to catch it.
    });

    return { employeeId, userAccountId: account.id, invitation };
  }

  /**
   * Unlink, without touching the account.
   *
   * Deleting the `user_account` or the membership is emphatically not this
   * endpoint's job: the person may belong to other companies, and their login
   * is theirs. Removing their company access is `DELETE /members/:id`, which is
   * a different decision with a different permission.
   */
  async unlinkAccount(employeeId: string) {
    const employee = await this.employees.findFirst({ id: employeeId, deletedAt: null });
    if (!employee) throw new ResourceNotFoundError('Employee', employeeId);

    if (!employee.userAccountId) {
      throw new ConflictError('This employee has no login to unlink.');
    }

    await this.employees.requireUpdateById(employeeId, { userAccountId: null });

    await this.audit.record({
      action: 'employee.user_unlinked',
      resourceType: 'employee',
      resourceId: employeeId,
      before: { userAccountId: employee.userAccountId },
    });
  }

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  private async assertEmployeeExists(tx: TenantTx, companyId: string, employeeId: string) {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, companyId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) throw new ResourceNotFoundError('Employee', employeeId);
  }

  /**
   * Every branch must exist IN THIS COMPANY.
   *
   * Checked as a set rather than one at a time, so a request naming five
   * branches with one foreign id fails before anything is written — and the
   * error names the offending ids rather than just the first.
   */
  private async assertBranchesExist(tx: TenantTx, companyId: string, branchIds: string[]) {
    const unique = [...new Set(branchIds)];
    const found = await tx.branch.findMany({
      where: { companyId, id: { in: unique }, deletedAt: null },
      select: { id: true },
    });

    const missing = unique.filter((id) => !found.some((b) => b.id === id));
    if (missing.length > 0) {
      // 404, not 400: a branch id belonging to another company must be
      // indistinguishable from one that does not exist.
      throw new ResourceNotFoundError('Branch', missing[0]);
    }
  }

  private async clearPrimaryBranch(tx: TenantTx, companyId: string, employeeId: string) {
    await tx.employeeBranch.updateMany({
      where: { companyId, employeeId, isPrimary: true },
      data: { isPrimary: false },
    });
  }

  private async assertCodeAvailable(
    tx: TenantTx,
    companyId: string,
    code: string,
    exceptEmployeeId?: string,
  ) {
    const clash = await tx.employee.findFirst({
      where: {
        companyId,
        employeeCode: code,
        deletedAt: null,
        ...(exceptEmployeeId ? { id: { not: exceptEmployeeId } } : {}),
      },
      select: { id: true },
    });

    if (clash) {
      throw new ConflictError(`Another employee already uses the code "${code}".`, {
        field: 'employeeCode',
        employeeId: clash.id,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

/** Map the partial unique index violation to the same 409 as the pre-check. */
function mapDuplicateCode(error: unknown, code: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictError(`Another employee already uses the code "${code}".`, {
      field: 'employeeCode',
    });
  }
  return error;
}

interface ProfileRow {
  jobTitle: string | null;
  bio: string | null;
  avatarFileId: string | null;
  languages: string[];
  specialties: string[];
  phone: string | null;
  emergencyContact: string | null;
}

/**
 * The list projection.
 *
 * `emergencyContact` is NOT here, and that is the point of shaping responses by
 * hand: it lives on the same row as `jobTitle` and `bio`, and a spread would
 * put a next-of-kin phone number into every list a receptionist can load.
 */
interface EmployeeSummaryRow {
  id: string;
  employeeCode: string | null;
  displayName: string;
  status: string;
  isBookable: boolean;
  acceptsWalkIns: boolean;
  calendarColor: string | null;
  hiredOn: Date | null;
  userAccountId: string | null;
  profile?: ProfileRow | null;
  /** `branch` is present on the detail query and absent on the list query. */
  branches?: Array<{
    branchId: string;
    isPrimary: boolean;
    branch?: { name: string; code: string };
  }>;
  userAccount?: { id: string; email: string; status: string; emailVerifiedAt?: Date | null } | null;
}

interface EmployeeDetailRow extends EmployeeSummaryRow {
  services?: Array<{
    serviceId: string;
    durationOverrideMin: number | null;
    priceOverrideMinor: bigint | null;
    proficiency: number | null;
    service?: { name: string; code: string | null };
  }>;
}

function toEmployeeResponse(employee: EmployeeSummaryRow) {
  return {
    id: employee.id,
    employeeCode: employee.employeeCode,
    displayName: employee.displayName,
    status: employee.status,
    isBookable: employee.isBookable,
    acceptsWalkIns: employee.acceptsWalkIns,
    calendarColor: employee.calendarColor,
    hiredOn: employee.hiredOn ? employee.hiredOn.toISOString().slice(0, 10) : null,
    jobTitle: employee.profile?.jobTitle ?? null,
    branchIds: employee.branches?.map((b) => b.branchId) ?? [],
    primaryBranchId: employee.branches?.find((b) => b.isPrimary)?.branchId ?? null,
    account: toAccountSummary(employee),
    hasAccount: employee.userAccountId !== null,
  };
}

/**
 * What is knowable about the linked login, which is less than it looks.
 *
 * `user_account` is reachable from the tenant connection ONLY through the
 * `user_account_via_membership` RLS policy — that is, only once the person is
 * actually a member of this company. Between linking and accepting the
 * invitation they are not, so the join comes back null even though
 * `employee.userAccountId` is set.
 *
 * That is the policy working, not a bug, and the response says so rather than
 * pretending there is no account: `PENDING_ACCEPTANCE` with a null email is the
 * honest answer, and it is exactly the state a "resend invitation" button wants
 * to key off.
 */
function toAccountSummary(employee: EmployeeSummaryRow) {
  if (!employee.userAccountId) return null;

  return {
    userAccountId: employee.userAccountId,
    email: employee.userAccount?.email ?? null,
    status: employee.userAccount?.status ?? 'PENDING_ACCEPTANCE',
  };
}

function toEmployeeDetailResponse(employee: EmployeeDetailRow) {
  return {
    ...toEmployeeResponse(employee),
    /**
     * The public half — what a booking page may render. Kept as its own object
     * so the boundary between it and the private fields is visible rather than
     * remembered.
     */
    publicProfile: {
      displayName: employee.displayName,
      jobTitle: employee.profile?.jobTitle ?? null,
      bio: employee.profile?.bio ?? null,
      avatarFileId: employee.profile?.avatarFileId ?? null,
      languages: employee.profile?.languages ?? [],
      specialties: employee.profile?.specialties ?? [],
    },
    /** Staff-only. Never merged into publicProfile. */
    privateProfile: {
      phone: employee.profile?.phone ?? null,
      emergencyContact: employee.profile?.emergencyContact ?? null,
    },
    branches:
      employee.branches?.map((b) => ({
        branchId: b.branchId,
        name: b.branch?.name ?? null,
        code: b.branch?.code ?? null,
        isPrimary: b.isPrimary,
      })) ?? [],
    services:
      employee.services?.map((s) => ({
        serviceId: s.serviceId,
        name: s.service?.name ?? null,
        durationOverrideMin: s.durationOverrideMin,
        priceOverrideMinor: s.priceOverrideMinor?.toString() ?? null,
        proficiency: s.proficiency,
      })) ?? [],
    account: employee.userAccountId
      ? {
          ...toAccountSummary(employee)!,
          emailVerified: employee.userAccount?.emailVerifiedAt != null,
        }
      : null,
  };
}
