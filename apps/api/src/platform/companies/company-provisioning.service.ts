import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { ConflictError, ResourceNotFoundError, ValidationFailedError } from '../../common/errors';
import { PlatformPrismaService } from '../../database/platform-prisma.service';
import { SYSTEM_ROLES, SYSTEM_ROLE_PERMISSIONS } from '../../authz/permissions';
import { TenantDirectoryService } from '../../tenancy/directory/tenant-directory.service';
import type { ProvisionCompanyDto } from './dto/provision-company.dto';

export interface ProvisionedCompany {
  company: {
    id: string;
    slug: string;
    legalName: string;
    displayName: string;
    status: string;
    defaultTimezoneName: string;
    currencyCode: string;
    locale: string;
    createdAt: Date;
  };
  owner: {
    userAccountId: string;
    companyUserId: string;
    email: string;
    fullName: string;
    /** Membership status — ACTIVE if they can already sign in, else INVITED. */
    status: string;
    /** True when provisioning created the account rather than reusing one. */
    accountCreated: boolean;
    /**
     * True when the owner cannot sign in yet and needs an invitation link.
     * The onboarding UI branches on this rather than inferring it from status.
     */
    requiresInvitation: boolean;
  };
  roles: Array<{ id: string; key: string; name: string; isSystem: boolean }>;
}

/** Human labels for the seeded roles. Keys come from SYSTEM_ROLES. */
const SYSTEM_ROLE_NAMES: Record<string, string> = {
  OWNER: 'Owner',
  ADMIN: 'Administrator',
  BRANCH_MANAGER: 'Branch manager',
  RECEPTIONIST: 'Receptionist',
  EMPLOYEE: 'Employee',
  READ_ONLY: 'Read only',
};

/**
 * Creates a company and everything it cannot function without.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RUNS ON THE PLATFORM CONNECTION
 * ---------------------------------------------------------------------------
 *
 * Two reasons, and both are structural rather than convenient:
 *
 *   1. There is no tenant to scope to. `TenantPrismaService.runInCompany` needs
 *      a company id, and the company does not exist until halfway through this
 *      transaction.
 *   2. `user_account` carries FORCE ROW LEVEL SECURITY with a SELECT-only
 *      policy (001_hardening.sql 8e), so the owner's account cannot be created
 *      from a tenant connection at all.
 *
 * `src/platform/**` is allowlisted for PlatformPrismaService in
 * packages/eslint-config/nest.js, so no new exemption is introduced here.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS ONE TRANSACTION
 * ---------------------------------------------------------------------------
 *
 * A company with no roles cannot grant anyone anything; a company with no owner
 * is unadministrable and, because there is no self-serve signup, unrecoverable
 * without another operator call. Both are worse than no company at all, so
 * every write below commits together or not at all.
 *
 * The one thing deliberately OUTSIDE the transaction is the directory cache
 * invalidation, which must happen after the commit — see the note at the end.
 */
@Injectable()
export class CompanyProvisioningService {
  private readonly logger = new Logger(CompanyProvisioningService.name);

  constructor(
    private readonly prisma: PlatformPrismaService,
    private readonly directory: TenantDirectoryService,
    private readonly audit: AuditService,
  ) {}

  async provision(input: ProvisionCompanyDto): Promise<ProvisionedCompany> {
    await this.assertReferencesExist(input);
    await this.assertSlugAvailable(input.slug);

    const result = await this.runProvisioningTransaction(input);

    // AFTER the commit, never inside it.
    //
    // `findCompanyIdBySlug` caches misses as well as hits, so a slug probed
    // before provisioning stays unresolvable for TENANT_CACHE_TTL_SECONDS.
    // Invalidating inside the transaction would open the same hole from the
    // other side: a concurrent read could repopulate the cache from a snapshot
    // that does not include a company which then commits.
    this.directory.invalidate(result.company.id, result.company.slug);

    await this.audit.record({
      action: 'platform.company.provisioned',
      resourceType: 'company',
      resourceId: result.company.id,
      // A platform-level row (company_id NULL): this is an action ON a company,
      // not within one, and the operator who did it is not a member.
      platformLevel: true,
      after: {
        slug: result.company.slug,
        displayName: result.company.displayName,
        ownerEmail: result.owner.email,
        ownerAccountCreated: result.owner.accountCreated,
      },
    });

    this.logger.log(
      `Provisioned company ${result.company.slug} (${result.company.id}) ` +
        `with owner ${result.owner.email}`,
    );

    return {
      company: {
        id: result.company.id,
        slug: result.company.slug,
        legalName: result.company.legalName,
        displayName: result.company.displayName,
        status: result.company.status,
        defaultTimezoneName: result.company.defaultTimezoneName,
        currencyCode: result.company.currencyCode,
        locale: result.company.locale,
        createdAt: result.company.createdAt,
      },
      owner: result.owner,
      roles: result.roles.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        isSystem: r.isSystem,
      })),
    };
  }

  /**
   * Every write, in one transaction.
   *
   * Nothing here is conditional on anything outside it, so a failure at any
   * step — a bad foreign key, a lost slug race, a missing permission row —
   * leaves the database exactly as it was. There is no compensating cleanup
   * path because there is nothing to compensate for.
   */
  private async runProvisioningTransaction(input: ProvisionCompanyDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const company = await tx.company.create({
          data: {
            slug: input.slug,
            legalName: input.legalName,
            displayName: input.displayName,
            // PENDING_SETUP, not ACTIVE. The owner has not accepted, there are
            // no branches and no services — nothing can be booked yet, and the
            // status should say so rather than flatter the situation.
            status: 'PENDING_SETUP',
            defaultTimezoneName: input.defaultTimezoneName,
            currencyCode: input.currencyCode,
            locale: input.locale,
            registrationNumber: input.registrationNumber,
            taxNumber: input.taxNumber,
            contactEmail: input.contactEmail,
            contactPhone: input.contactPhone,
          },
        });

        // Schema defaults carry every booking policy value, so this is a bare
        // create. Tuning them is the company's job, not provisioning's.
        await tx.companySettings.create({ data: { companyId: company.id } });

        const roles = await this.createSystemRoles(tx, company.id);

        const ownerRole = roles.find((r) => r.key === SYSTEM_ROLES.OWNER);
        if (!ownerRole) {
          // Unreachable unless SYSTEM_ROLE_PERMISSIONS loses its OWNER entry,
          // in which case rolling back is the only safe outcome.
          throw new Error('System role seeding produced no OWNER role.');
        }

        const owner = await this.createOwner(tx, company.id, ownerRole.id, input.owner);

        return { company, roles, owner };
      });
    } catch (error) {
      // The slug check above is a check-then-act, so two concurrent provisions
      // of the same slug both pass it and one loses at the unique index. Map
      // that to the same 409, so the race is indistinguishable from the
      // ordinary case rather than surfacing as a 500.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(`The slug "${input.slug}" is already taken.`, { field: 'slug' });
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Pre-flight validation
  // ---------------------------------------------------------------------------

  /**
   * Check the reference-table foreign keys before opening a transaction.
   *
   * Both would be caught by the database, but as an opaque constraint violation
   * that the exception filter can only render as a 500. Checking here turns
   * "unknown timezone" into a 400 that names the field, which is the difference
   * between a caller fixing their request and filing a bug.
   */
  private async assertReferencesExist(input: ProvisionCompanyDto): Promise<void> {
    const [timezone, currency] = await Promise.all([
      this.prisma.timezone.findUnique({ where: { name: input.defaultTimezoneName } }),
      this.prisma.currency.findUnique({ where: { code: input.currencyCode } }),
    ]);

    const issues: Record<string, string> = {};
    if (!timezone) issues.defaultTimezoneName = 'Unknown IANA timezone.';
    if (!currency) issues.currencyCode = 'Unknown or unsupported currency code.';

    if (Object.keys(issues).length > 0) {
      throw new ValidationFailedError(issues);
    }
  }

  /**
   * Report a taken slug as a clean 409 rather than letting the unique index
   * decide.
   *
   * This is a check-then-act, so it is deliberately NOT the only defence: two
   * concurrent provisions of the same slug both pass here and one loses at the
   * index. `provision` maps that to the same 409, so the race and the ordinary
   * case are indistinguishable to the caller. The check exists for the message,
   * the constraint exists for the correctness.
   */
  private async assertSlugAvailable(slugValue: string): Promise<void> {
    const existing = await this.prisma.company.findUnique({
      where: { slug: slugValue },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictError(`The slug "${slugValue}" is already taken.`, { field: 'slug' });
    }
  }

  // ---------------------------------------------------------------------------
  // Transaction steps
  // ---------------------------------------------------------------------------

  private async createSystemRoles(tx: Prisma.TransactionClient, companyId: string) {
    // Every permission the roles reference must already exist in the catalog
    // table — company_role_permission has a foreign key to it. Checking once
    // here turns an unseeded database into a message that says so, instead of a
    // foreign-key violation from thirty rows down.
    const referenced = [
      ...new Set(Object.values(SYSTEM_ROLE_PERMISSIONS).flatMap((keys) => [...keys])),
    ];
    const known = await tx.permission.findMany({
      where: { key: { in: referenced } },
      select: { key: true },
    });
    const missing = referenced.filter((key) => !known.some((k) => k.key === key));

    if (missing.length > 0) {
      throw new Error(
        `The permission catalog is missing ${missing.length} key(s) the system roles ` +
          `reference (${missing.slice(0, 5).join(', ')}). Run \`pnpm db:seed\`.`,
      );
    }

    const roles = [];

    for (const key of Object.values(SYSTEM_ROLES)) {
      const role = await tx.companyRole.create({
        data: {
          companyId,
          key,
          name: SYSTEM_ROLE_NAMES[key] ?? key,
          // Immutable: a tenant must not be able to edit OWNER into granting
          // itself something the platform did not intend. Enforced by the role
          // module; recorded here.
          isSystem: true,
        },
      });

      await tx.companyRolePermission.createMany({
        data: SYSTEM_ROLE_PERMISSIONS[key].map((permissionKey) => ({
          companyId,
          roleId: role.id,
          permissionKey,
        })),
      });

      roles.push(role);
    }

    return roles;
  }

  /**
   * Attach the first owner.
   *
   * The account is found or created by email, because the owner of a new
   * company may already be a member of another one — a consultant running three
   * salons is an ordinary case, not an edge case, and creating a second account
   * for the same address would split their identity permanently.
   *
   * Membership status mirrors whether the person can actually authenticate:
   * an existing ACTIVE account with a password is a member immediately, while a
   * freshly created placeholder is INVITED until they accept and set one. The
   * alternative — marking everyone ACTIVE — would report a company as staffed
   * by someone who cannot sign in.
   */
  private async createOwner(
    tx: Prisma.TransactionClient,
    companyId: string,
    ownerRoleId: string,
    input: { email: string; fullName: string },
  ) {
    const existing = await tx.userAccount.findFirst({
      where: { email: input.email },
      select: { id: true, email: true, fullName: true, status: true, deletedAt: true },
    });

    if (existing?.deletedAt) {
      // Reusing a soft-deleted account would silently resurrect someone who was
      // removed. Refuse and let a human decide.
      throw new ConflictError(
        'That email belongs to a deleted account. Restore it or use another address.',
        { field: 'owner.email' },
      );
    }

    if (existing && existing.status === 'DISABLED') {
      throw new ConflictError('That email belongs to a disabled account.', {
        field: 'owner.email',
      });
    }

    const account =
      existing ??
      (await tx.userAccount.create({
        data: {
          email: input.email,
          fullName: input.fullName,
          // No password. The account exists so the membership has something to
          // point at; it cannot be signed into until an invitation is accepted.
          status: 'INVITED',
        },
        select: { id: true, email: true, fullName: true, status: true, deletedAt: true },
      }));

    const canAlreadySignIn = existing !== null && existing.status === 'ACTIVE';

    const membership = await tx.companyUser.create({
      data: {
        companyId,
        userAccountId: account.id,
        // The ONLY place in the codebase that writes true. No DTO reaches it.
        isOwner: true,
        status: canAlreadySignIn ? 'ACTIVE' : 'INVITED',
        joinedAt: canAlreadySignIn ? new Date() : null,
        invitedAt: canAlreadySignIn ? null : new Date(),
      },
      select: { id: true, status: true },
    });

    await tx.companyUserRole.create({
      data: { companyId, companyUserId: membership.id, roleId: ownerRoleId },
    });

    return {
      userAccountId: account.id,
      companyUserId: membership.id,
      email: account.email,
      fullName: account.fullName,
      status: membership.status,
      accountCreated: existing === null,
      requiresInvitation: !canAlreadySignIn,
    };
  }

  // ---------------------------------------------------------------------------
  // Read-back
  // ---------------------------------------------------------------------------

  /**
   * Read a provisioned company back.
   *
   * Exists so the onboarding flow can re-read what it created without holding
   * the provisioning response, and so an operator can confirm a company's state
   * after the fact. Platform connection, so it is not subject to RLS — which is
   * the point: an operator asking about a company they are not a member of is
   * the normal case here.
   */
  async findById(companyId: string) {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, deletedAt: null },
      select: {
        id: true,
        slug: true,
        legalName: true,
        displayName: true,
        status: true,
        defaultTimezoneName: true,
        currencyCode: true,
        locale: true,
        contactEmail: true,
        createdAt: true,
        suspendedAt: true,
        _count: { select: { users: true, roles: true, branches: true } },
      },
    });

    if (!company) {
      throw new ResourceNotFoundError('Company', companyId);
    }

    return company;
  }
}
