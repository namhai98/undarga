import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type OnboardingStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { businessWeekRows, effectiveFromDate } from '../branches/business-hours';
import { ConflictError, ValidationFailedError } from '../common/errors';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import { CompanyProvisioningService } from '../platform/companies/company-provisioning.service';
import { companySlugSchema } from '../platform/companies/dto/provision-company.dto';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import type { CompanyUserActor } from '../tenancy/context/context.types';
import { TenantDirectoryService } from '../tenancy/directory/tenant-directory.service';
import { MembershipService } from '../tenancy/membership/membership.service';
import type {
  CompleteOnboardingDto,
  CreateOnboardingCompanyDto,
  OnboardingSetupDto,
} from './dto/onboarding.dto';

/**
 * How many ACTIVE companies one account may own through self-serve onboarding.
 *
 * Every new company starts a paid-plan trial, so an unbounded create is an
 * unbounded supply of free trials. Ten is far past any honest multi-location
 * owner (who would use branches) and is enforced here rather than by a plan,
 * because the account, not a company, is what is being limited.
 */
export const MAX_OWNED_COMPANIES = 10;

/** Everything one onboarding step needs to be allowed to write. */
export const SETUP_PERMISSIONS = [
  COMPANY_PERMISSIONS.COMPANY_WRITE,
  COMPANY_PERMISSIONS.SETTINGS_WRITE,
  COMPANY_PERMISSIONS.BRANCH_WRITE,
] as const;
export const COMPLETE_PERMISSIONS = [
  COMPANY_PERMISSIONS.COMPANY_WRITE,
  COMPANY_PERMISSIONS.SERVICE_WRITE,
] as const;

export type OnboardingStep = 'COMPANY' | 'BRANCH' | 'BUSINESS_SETTINGS' | 'SERVICES';

type BranchInput = CreateOnboardingCompanyDto['branch'];
type HoursInput = CreateOnboardingCompanyDto['business']['businessHours'];

/** The two writes `writeInitialBranch` makes, on either connection. */
type BranchWriter = Pick<Prisma.TransactionClient, 'branch' | 'businessHours'>;

/**
 * ===========================================================================
 * COMPANY ONBOARDING
 * ===========================================================================
 *
 * Two ways into the same wizard (docs/ONBOARDING.md):
 *
 *   SELF-SERVE   A signed-in account creates a company. Company, settings,
 *                roles, the caller's OWNER membership, the first branch and the
 *                default plan's trial are ONE transaction — see
 *                `CompanyProvisioningService.createForAccount`. -> IN_PROGRESS
 *
 *   PROVISIONED  An operator created the company (NOT_STARTED, no branch). Its
 *                owner finishes steps 2-3 through `setup`, in one tenant
 *                transaction. -> IN_PROGRESS
 *
 * Either way `complete` then adds the optional initial services and marks the
 * company COMPLETED, again in one transaction.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE COMPANY ID COMES FROM
 * ---------------------------------------------------------------------------
 *
 * Never from a body. `create` has no company yet; `setup` and `complete` take
 * the id TenantGuard resolved from `:companyId` and proved the caller a member
 * of, with the permissions each step writes; `status` runs the same
 * `MembershipService.authorize` the guard does. Onboarding state is guidance for
 * the web app — nothing in the API is refused because a company has not
 * finished it, and the platform realm never sees it.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly provisioning: CompanyProvisioningService,
    private readonly db: TenantPrismaService,
    private readonly membership: MembershipService,
    private readonly directory: TenantDirectoryService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Self-serve: create
  // ---------------------------------------------------------------------------

  async createCompany(actor: CompanyUserActor, input: CreateOnboardingCompanyDto) {
    const memberships = await this.directory.listMembershipsForUser(actor.userAccountId);
    const owned = memberships.filter((m) => m.isOwner).length;
    if (owned >= MAX_OWNED_COMPANIES) {
      throw new ConflictError(`An account can own at most ${MAX_OWNED_COMPANIES} companies.`, {
        field: 'company',
        owned,
      });
    }

    const { company, branch, business } = input;

    const created = await this.provisioning.createForAccount(
      {
        slug: company.slug,
        displayName: company.displayName,
        legalName: company.legalName ?? company.displayName,
        // Step 2's timezone is the company default too: a one-branch company
        // has one timezone, and the branches module prefills from it later.
        defaultTimezoneName: branch.timezoneName,
        currencyCode: business.currencyCode,
        locale: business.locale,
        registrationNumber: business.registrationNumber,
        taxNumber: business.taxNumber,
        contactEmail: business.contactEmail,
        contactPhone: business.contactPhone,
      },
      actor.userAccountId,
      async (tx, companyId) => {
        // The first branch needs no plan check: every plan allows one, and
        // `EntitlementsService` reads committed state, which cannot see this
        // company yet.
        const firstBranch = await writeInitialBranch(tx, companyId, branch, business.businessHours);
        const subscription = await tx.subscription.findFirst({
          where: { companyId },
          select: { status: true, trialEndsAt: true, plan: { select: { key: true, name: true } } },
        });
        return { branch: firstBranch, subscription };
      },
    );

    const companyId = created.company.id;
    // Nothing should have cached this id, but a stale "unsubscribed, therefore
    // unrestricted" answer is cheap to rule out.
    this.entitlements.invalidate(companyId);

    await this.audit.recordForCompany(companyId, {
      action: 'onboarding.company_created',
      resourceType: 'company',
      resourceId: companyId,
      after: {
        slug: created.company.slug,
        displayName: created.company.displayName,
        timezone: created.company.defaultTimezoneName,
        currencyCode: created.company.currencyCode,
        branchId: created.setup.branch.id,
        planKey: created.setup.subscription?.plan.key ?? null,
      },
    });

    this.logger.log(
      `Company ${created.company.slug} (${companyId}) created through onboarding by ${actor.userAccountId}`,
    );

    return {
      company: created.company,
      membership: {
        companyUserId: created.owner.companyUserId,
        isOwner: true,
        status: created.owner.status,
      },
      branch: created.setup.branch,
      subscription: created.setup.subscription
        ? {
            status: created.setup.subscription.status,
            planKey: created.setup.subscription.plan.key,
            planName: created.setup.subscription.plan.name,
            trialEndsAt: created.setup.subscription.trialEndsAt,
          }
        : null,
      onboarding: { status: 'IN_PROGRESS' as const, nextStep: 'SERVICES' as const },
    };
  }

  async slugAvailability(slug: string) {
    const parsed = companySlugSchema.safeParse(slug);
    if (!parsed.success) {
      return { slug, available: false, reason: parsed.error.issues[0]?.message ?? 'Invalid slug.' };
    }
    const available = await this.provisioning.isSlugAvailable(slug);
    return { slug, available, reason: available ? null : 'That identifier is already taken.' };
  }

  // ---------------------------------------------------------------------------
  // Provisioned: setup (steps 2-3 for an existing company)
  // ---------------------------------------------------------------------------

  async setup(companyId: string, input: OnboardingSetupDto) {
    const { company, branch, business } = input;

    const result = await this.db.runInCompany(companyId, async (tx) => {
      const current = await tx.company.findFirstOrThrow({
        where: { id: companyId },
        select: { slug: true, status: true, onboardingStatus: true },
      });
      if (current.onboardingStatus !== 'NOT_STARTED') {
        throw new ConflictError('This company has already been set up.', {
          onboardingStatus: current.onboardingStatus,
        });
      }

      await assertReferencesExist(tx, branch.timezoneName, business.currencyCode);
      // An existing company has committed state, so the normal plan check applies.
      await this.entitlements.assertCanAdd(tx, companyId, 'BRANCH');

      const firstBranch = await writeInitialBranch(
        // The extended tenant client's delegates are the same at runtime but do
        // not unify with Prisma's base generics. The writes it makes are
        // company-scoped, so the tenant-scope extension and RLS both apply.
        tx as unknown as BranchWriter,
        companyId,
        branch,
        business.businessHours,
      );

      await tx.company.update({
        where: { id: companyId },
        data: {
          displayName: company.displayName,
          legalName: company.legalName ?? company.displayName,
          defaultTimezoneName: branch.timezoneName,
          currencyCode: business.currencyCode,
          ...(business.locale ? { locale: business.locale } : {}),
          contactEmail: business.contactEmail ?? null,
          contactPhone: business.contactPhone ?? null,
          registrationNumber: business.registrationNumber ?? null,
          taxNumber: business.taxNumber ?? null,
          onboardingStatus: 'IN_PROGRESS',
          // Set up now: it has a branch. Only PENDING_SETUP moves — a status an
          // operator chose is not this flow's to change.
          ...(current.status === 'PENDING_SETUP' ? { status: 'ACTIVE' as const } : {}),
        },
      });

      return {
        slug: current.slug,
        branch: firstBranch,
        activated: current.status === 'PENDING_SETUP',
      };
    });

    // Name, currency and possibly status changed: every cached summary is stale.
    this.directory.invalidate(companyId, result.slug);
    this.membership.invalidateCompany(companyId);

    await this.audit.record({
      action: 'onboarding.setup_completed',
      resourceType: 'company',
      resourceId: companyId,
      after: {
        displayName: company.displayName,
        timezone: branch.timezoneName,
        currencyCode: business.currencyCode,
        branchId: result.branch.id,
        activated: result.activated,
      },
    });

    return { branch: result.branch, onboarding: await this.statusFor(companyId) };
  }

  // ---------------------------------------------------------------------------
  // Both: complete (step 4 + finish)
  // ---------------------------------------------------------------------------

  async complete(companyId: string, input: CompleteOnboardingDto) {
    const created = await this.db.runInCompany(companyId, async (tx) => {
      const company = await tx.company.findFirstOrThrow({
        where: { id: companyId },
        select: { onboardingStatus: true, currencyCode: true },
      });
      if (company.onboardingStatus === 'COMPLETED') {
        throw new ConflictError('Onboarding is already complete. Add services from the catalog.', {
          onboardingStatus: company.onboardingStatus,
        });
      }
      if (company.onboardingStatus === 'NOT_STARTED') {
        throw new ConflictError('Set up the first branch before finishing onboarding.', {
          onboardingStatus: company.onboardingStatus,
        });
      }

      const services = await writeInitialServices(
        tx,
        companyId,
        company.currencyCode,
        input.services,
        // The normal per-service plan check, under its advisory lock.
        () => this.entitlements.assertCanAdd(tx, companyId, 'SERVICE'),
      );

      await tx.company.update({
        where: { id: companyId },
        data: { onboardingStatus: 'COMPLETED', onboardingCompletedAt: new Date() },
      });

      return services;
    });

    await this.audit.record({
      action: 'onboarding.completed',
      resourceType: 'company',
      resourceId: companyId,
      after: {
        servicesSkipped: created.length === 0,
        services: created.map((s) => ({ id: s.id, name: s.name })),
      },
    });

    return { services: created, onboarding: await this.statusFor(companyId) };
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /**
   * Where the caller is in onboarding.
   *
   * The company is the one asked for, else the token's verified active company,
   * else the caller's first. Whichever it is, it goes through
   * `MembershipService.authorize` — the guard's own check — so naming another
   * tenant's id answers exactly like naming one that does not exist.
   */
  async status(actor: CompanyUserActor, requested?: string, activeCompanyId?: string) {
    const memberships = await this.directory.listMembershipsForUser(actor.userAccountId);
    const companyId = requested ?? activeCompanyId ?? memberships[0]?.companyId;

    if (!companyId) {
      // Nothing to report on: the account belongs to no company yet.
      return {
        status: 'NOT_STARTED' as OnboardingStatus,
        company: null,
        steps: { company: false, branch: false, businessSettings: false, services: false },
        nextStep: 'COMPANY' as OnboardingStep,
        canManage: true,
        completedAt: null,
      };
    }

    const tenant = await this.membership.authorize(
      actor,
      companyId,
      requested ? 'ROUTE_PARAM' : 'ACTIVE_COMPANY_CLAIM',
    );
    const canManage = [...SETUP_PERMISSIONS, ...COMPLETE_PERMISSIONS].every((p) =>
      tenant.permissions.has(p),
    );

    return { ...(await this.statusFor(companyId)), canManage };
  }

  private async statusFor(companyId: string) {
    const { company, branches, services } = await this.db.runInCompany(companyId, async (tx) => {
      const [company, branches, services] = await Promise.all([
        tx.company.findFirstOrThrow({
          where: { id: companyId },
          select: {
            id: true,
            slug: true,
            displayName: true,
            status: true,
            defaultTimezoneName: true,
            currencyCode: true,
            onboardingStatus: true,
            onboardingCompletedAt: true,
          },
        }),
        tx.branch.count({ where: { companyId, deletedAt: null } }),
        tx.service.count({ where: { companyId, deletedAt: null } }),
      ]);
      return { company, branches, services };
    });

    const setUp = company.onboardingStatus !== 'NOT_STARTED';
    const nextStep: OnboardingStep | null =
      company.onboardingStatus === 'COMPLETED'
        ? null
        : setUp
          ? 'SERVICES'
          : branches === 0
            ? 'BRANCH'
            : 'BUSINESS_SETTINGS';

    return {
      status: company.onboardingStatus,
      company: {
        id: company.id,
        slug: company.slug,
        displayName: company.displayName,
        status: company.status,
        defaultTimezoneName: company.defaultTimezoneName,
        currencyCode: company.currencyCode,
      },
      steps: {
        company: true,
        branch: branches > 0,
        businessSettings: setUp,
        services: services > 0,
      },
      nextStep,
      completedAt: company.onboardingCompletedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Writes shared by both paths
// ---------------------------------------------------------------------------

/**
 * The first branch and, optionally, its opening hours.
 *
 * Runs on the provisioning transaction (self-serve) or a tenant transaction
 * (setup). Every write names `companyId`, so it is equally correct on both —
 * and on the tenant one RLS checks it again.
 */
async function writeInitialBranch(
  tx: BranchWriter,
  companyId: string,
  input: BranchInput,
  hours: HoursInput,
) {
  const code = input.code ?? 'MAIN';

  // Checked rather than left to the partial unique index: a violation inside a
  // transaction aborts it, and this one may be the company's whole creation.
  const clash = await tx.branch.findFirst({
    where: { companyId, code, deletedAt: null },
    select: { id: true },
  });
  if (clash) {
    throw new ConflictError(`Another branch already uses the code "${code}".`, {
      field: 'branch.code',
    });
  }

  const branch = await tx.branch.create({
    data: {
      companyId,
      code,
      name: input.name,
      timezoneName: input.timezoneName,
      phone: input.phone ?? null,
      email: input.email ?? null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      district: input.district ?? null,
      postalCode: input.postalCode ?? null,
      countryCode: input.countryCode ?? null,
    },
    select: { id: true, code: true, name: true, timezoneName: true },
  });

  if (hours?.length) {
    await tx.businessHours.createMany({
      data: businessWeekRows(companyId, branch.id, hours, effectiveFromDate()),
    });
  }

  return { ...branch, businessHoursSet: Boolean(hours?.length) };
}

/**
 * Initial services, each offered at every branch the company has.
 *
 * A category is matched by name (case-insensitive, top level) and created on
 * first use, so "Hair" typed on three services is one category.
 */
async function writeInitialServices(
  tx: TenantTx,
  companyId: string,
  currencyCode: string,
  services: CompleteOnboardingDto['services'],
  assertCanAddOne: () => Promise<void>,
) {
  if (services.length === 0) return [];

  const branches = await tx.branch.findMany({
    where: { companyId, deletedAt: null },
    select: { id: true },
  });
  const categories = new Map<string, string>();
  const created: Array<{
    id: string;
    name: string;
    categoryId: string | null;
    durationMin: number;
    priceMinor: string;
    currencyCode: string;
    status: string;
  }> = [];

  for (const service of services) {
    await assertCanAddOne();

    let categoryId: string | null = null;
    if (service.category) {
      const key = service.category.toLowerCase();
      categoryId = categories.get(key) ?? null;
      if (!categoryId) {
        const existing = await tx.serviceCategory.findFirst({
          where: {
            companyId,
            parentId: null,
            deletedAt: null,
            name: { equals: service.category, mode: 'insensitive' },
          },
          select: { id: true },
        });
        categoryId =
          existing?.id ??
          (
            await tx.serviceCategory.create({
              data: { companyId, name: service.category },
              select: { id: true },
            })
          ).id;
        categories.set(key, categoryId);
      }
    }

    const row = await tx.service.create({
      data: {
        companyId,
        categoryId,
        name: service.name,
        durationMin: service.durationMin,
        priceMinor: BigInt(service.priceMinor),
        currencyCode,
        status: service.isActive ? 'ACTIVE' : 'INACTIVE',
      },
      select: {
        id: true,
        name: true,
        categoryId: true,
        durationMin: true,
        priceMinor: true,
        currencyCode: true,
        status: true,
      },
    });

    if (branches.length > 0) {
      await tx.serviceBranch.createMany({
        data: branches.map((b) => ({ companyId, serviceId: row.id, branchId: b.id })),
      });
    }

    created.push({ ...row, priceMinor: row.priceMinor.toString() });
  }

  return created;
}

async function assertReferencesExist(tx: TenantTx, timezoneName: string, currencyCode: string) {
  const [timezone, currency] = await Promise.all([
    tx.timezone.findUnique({ where: { name: timezoneName } }),
    tx.currency.findUnique({ where: { code: currencyCode } }),
  ]);
  const issues: Record<string, string> = {};
  if (!timezone) issues['branch.timezoneName'] = 'Unknown IANA timezone.';
  if (!currency) issues['business.currencyCode'] = 'Unknown or unsupported currency code.';
  if (Object.keys(issues).length > 0) throw new ValidationFailedError(issues);
}
