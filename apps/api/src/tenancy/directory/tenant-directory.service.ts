import type { SubscriptionStatus } from '@prisma/client';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../../config';
import { TtlCache } from '../../common/cache';
import { PlatformPrismaService } from '../../database/platform-prisma.service';

export interface CompanySummary {
  readonly id: string;
  readonly slug: string;
  readonly status: string;
  readonly defaultTimezoneName: string;
  readonly currencyCode: string;
  readonly deletedAt: Date | null;
  /**
   * The subscription's state and the timestamps that move it, or null for a
   * company provisioned before subscriptions. Cached with the rest of the
   * summary; the EFFECTIVE status is worked out per request from these
   * timestamps, so a trial ending is honoured to the second regardless.
   */
  readonly subscription: {
    readonly status: SubscriptionStatus;
    readonly trialEndsAt: Date | null;
    readonly currentPeriodEnd: Date;
    readonly graceEndsAt: Date | null;
  } | null;
}

/**
 * Turns "a company was named" into "here is that company", before any tenant
 * context exists.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE THING RUNS ON THE BYPASSRLS CONNECTION
 * ---------------------------------------------------------------------------
 *
 * RLS filters rows by `current_setting('app.current_company_id')`. Resolving a
 * slug or hostname to a company id is the query that *produces* that value, so
 * it cannot itself run inside a tenant scope. There is no way around it; the
 * question is only how tightly it is contained.
 *
 * Containment here:
 *
 *   - This service is the ONLY consumer of PlatformPrismaService outside the
 *     platform module and the job dispatcher (enforced by the ESLint rule).
 *   - It reads six columns of `company` and one of `company_domain`. It cannot
 *     reach appointments, customers, payments or anything else, because it
 *     never queries them.
 *   - Everything it returns is non-secret: a slug and a status. Learning that
 *     a company exists is not a breach — learning what is inside it is, and
 *     that is the membership check's job, which runs immediately after.
 *   - Nothing it returns grants access. `MembershipService` decides that.
 *
 * The cache in front matters for a different reason: hostname resolution is on
 * the path of every public booking request, and without it every anonymous
 * page view is a database round trip on the privileged pool.
 */
@Injectable()
export class TenantDirectoryService implements OnModuleInit {
  private readonly logger = new Logger(TenantDirectoryService.name);

  private readonly bySlug: TtlCache<string | null>;
  private readonly byHostname: TtlCache<string | null>;
  private readonly byId: TtlCache<CompanySummary | null>;

  constructor(
    private readonly prisma: PlatformPrismaService,
    config: AppConfig,
  ) {
    const ttlMs = config.tenancy.cacheTtlSeconds * 1000;
    this.bySlug = new TtlCache(ttlMs, 20_000);
    this.byHostname = new TtlCache(ttlMs, 20_000);
    this.byId = new TtlCache(ttlMs, 20_000);
  }

  onModuleInit(): void {
    this.logger.log('Tenant directory ready (reads company + company_domain only)');
  }

  async findCompanyIdBySlug(slug: string): Promise<string | null> {
    return this.bySlug.getOrLoad(slug, async () => {
      const row = await this.prisma.company.findFirst({
        where: { slug, deletedAt: null },
        select: { id: true },
      });
      return row?.id ?? null;
    });
  }

  /**
   * Only hostnames whose DNS ownership has been verified resolve. An
   * unverified `company_domain` row is inert, which is what stops someone
   * pointing a CNAME at the platform and claiming a domain — and, worse,
   * receiving another tenant's branded booking page.
   */
  async findCompanyIdByVerifiedHostname(hostname: string): Promise<string | null> {
    return this.byHostname.getOrLoad(hostname, async () => {
      const row = await this.prisma.companyDomain.findFirst({
        where: { hostname, status: 'ACTIVE', verifiedAt: { not: null } },
        select: { companyId: true },
      });
      return row?.companyId ?? null;
    });
  }

  async getCompany(companyId: string): Promise<CompanySummary | null> {
    return this.byId.getOrLoad(companyId, async () => {
      const row = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          id: true,
          slug: true,
          status: true,
          defaultTimezoneName: true,
          currencyCode: true,
          deletedAt: true,
          subscription: {
            select: { status: true, trialEndsAt: true, currentPeriodEnd: true, graceEndsAt: true },
          },
        },
      });
      return row ?? null;
    });
  }

  /**
   * Every company this user may enter, with the company's display data.
   *
   * Legitimately cross-company — it is the user's own membership list, used by
   * `GET /me` and by the company switcher. RLS would block it from the tenant
   * connection by design, since there is no single company to scope to, so it
   * runs here on the directory connection with the userAccountId as the filter.
   *
   * The filter is the security control: it is taken from the verified token's
   * subject, never from anything the caller supplies.
   */
  async listMembershipsForUser(userAccountId: string): Promise<
    Array<{
      companyUserId: string;
      companyId: string;
      companySlug: string;
      companyName: string;
      companyStatus: string;
      isOwner: boolean;
      membershipStatus: string;
    }>
  > {
    const rows = await this.prisma.companyUser.findMany({
      where: {
        userAccountId,
        deletedAt: null,
        status: 'ACTIVE',
        company: { deletedAt: null, status: { in: ['ACTIVE', 'PENDING_SETUP'] } },
      },
      select: {
        id: true,
        companyId: true,
        isOwner: true,
        status: true,
        company: { select: { slug: true, displayName: true, status: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => ({
      companyUserId: row.id,
      companyId: row.companyId,
      companySlug: row.company.slug,
      companyName: row.company.displayName,
      companyStatus: row.company.status,
      isOwner: row.isOwner,
      membershipStatus: row.status,
    }));
  }

  /** Called when a company is renamed, suspended, or has a domain change. */
  invalidate(companyId: string, slug?: string, hostname?: string): void {
    this.byId.delete(companyId);
    if (slug) this.bySlug.delete(slug);
    if (hostname) this.byHostname.delete(hostname);
  }

  invalidateAll(): void {
    this.byId.clear();
    this.bySlug.clear();
    this.byHostname.clear();
  }
}
