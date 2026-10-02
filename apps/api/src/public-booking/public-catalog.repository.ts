import { Injectable } from '@nestjs/common';
import { ResourceNotFoundError } from '../common/errors';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import { RequestContextService } from '../tenancy/context/request-context.service';

/**
 * What an anonymous visitor may read about one company.
 *
 * ---------------------------------------------------------------------------
 * THE `select` IS THE SECURITY BOUNDARY
 * ---------------------------------------------------------------------------
 *
 * Every query here names its columns. Legal name, tax number, contact email,
 * cost overrides, employee accounts, customer data — none of it is loaded, so
 * none of it can leak through a response mapper that forgets to drop a field.
 * Adding a column to a public response means adding it here, deliberately.
 *
 * Like the availability repository, this reads several modules' tables in one
 * place (docs/ARCHITECTURE-RULES.md rule 5 notwithstanding): it is a single
 * read-only projection of "the public catalogue", and splitting it across
 * branch, catalog and employee services would spread one security decision
 * across three files.
 *
 * ---------------------------------------------------------------------------
 * WHAT "PUBLIC" MEANS
 * ---------------------------------------------------------------------------
 *
 *   branch    ACTIVE, not deleted, online booking allowed (branch setting,
 *             else company setting)
 *   service   ACTIVE, isOnlineBookable, not deleted, offered and available at
 *             that branch
 *   employee  ACTIVE, isBookable, not deleted, provides the service, works at
 *             the branch
 *
 * Anything outside these is a 404 — never "exists but private".
 */
@Injectable()
export class PublicCatalogRepository {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly context: RequestContextService,
  ) {}

  async company() {
    return this.run(async (tx, companyId) => {
      const [company, branding, settings] = await Promise.all([
        tx.company.findFirstOrThrow({
          where: { id: companyId },
          select: { slug: true, displayName: true, locale: true, currencyCode: true },
        }),
        tx.companyBranding.findFirst({
          where: { companyId },
          select: {
            primaryColor: true,
            accentColor: true,
            bookingPageHeadline: true,
            bookingPageBlurb: true,
          },
        }),
        tx.companySettings.findFirst({
          where: { companyId },
          select: { allowOnlineBooking: true },
        }),
      ]);

      const branches = await this.publicBranches(tx, companyId, settings?.allowOnlineBooking ?? true);

      return {
        slug: company.slug,
        name: company.displayName,
        locale: company.locale,
        currencyCode: company.currencyCode,
        branding: branding
          ? {
              primaryColor: branding.primaryColor,
              accentColor: branding.accentColor,
              headline: branding.bookingPageHeadline,
              blurb: branding.bookingPageBlurb,
            }
          : null,
        branches,
      };
    });
  }

  /** Categories and the services bookable online at one branch. */
  async services(branchId: string) {
    return this.run(async (tx, companyId) => {
      await this.assertPublicBranch(tx, companyId, branchId);

      const rows = await tx.serviceBranch.findMany({
        where: {
          companyId,
          branchId,
          isAvailable: true,
          service: {
            companyId,
            status: 'ACTIVE',
            isOnlineBookable: true,
            deletedAt: null,
          },
        },
        select: {
          priceOverrideMinor: true,
          durationOverrideMin: true,
          service: {
            select: {
              id: true,
              name: true,
              description: true,
              durationMin: true,
              priceMinor: true,
              currencyCode: true,
              requiresEmployee: true,
              color: true,
              sortOrder: true,
              category: {
                select: { id: true, name: true, sortOrder: true, status: true, deletedAt: true },
              },
            },
          },
        },
      });

      const services = rows
        .map(({ service, priceOverrideMinor, durationOverrideMin }) => {
          // A hidden category must not surface through its services; they
          // simply appear uncategorised.
          const category =
            service.category && service.category.status === 'ACTIVE' && !service.category.deletedAt
              ? service.category
              : null;
          return {
            id: service.id,
            name: service.name,
            description: service.description,
            durationMin: durationOverrideMin ?? service.durationMin,
            priceMinor: (priceOverrideMinor ?? service.priceMinor).toString(),
            currencyCode: service.currencyCode,
            requiresEmployee: service.requiresEmployee,
            color: service.color,
            categoryId: category?.id ?? null,
            sortOrder: service.sortOrder,
            categorySort: category?.sortOrder ?? Number.MAX_SAFE_INTEGER,
            categoryName: category?.name ?? null,
          };
        })
        .sort(
          (a, b) =>
            a.categorySort - b.categorySort ||
            a.sortOrder - b.sortOrder ||
            a.name.localeCompare(b.name),
        );

      const categories = new Map<string, { id: string; name: string }>();
      for (const s of services) {
        if (s.categoryId && s.categoryName) categories.set(s.categoryId, { id: s.categoryId, name: s.categoryName });
      }

      return {
        categories: [...categories.values()],
        services: services.map(({ categorySort: _cs, categoryName: _cn, sortOrder: _so, ...rest }) => rest),
      };
    });
  }

  /** Staff a visitor may choose for a service at a branch. */
  async employees(branchId: string, serviceId: string) {
    return this.run(async (tx, companyId) => {
      await this.assertPublicBranch(tx, companyId, branchId);
      await this.assertPublicService(tx, companyId, branchId, serviceId);

      const rows = await tx.employee.findMany({
        where: {
          companyId,
          status: 'ACTIVE',
          isBookable: true,
          deletedAt: null,
          services: { some: { companyId, serviceId } },
          branches: { some: { companyId, branchId } },
        },
        select: { id: true, displayName: true, profile: { select: { jobTitle: true } } },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      });

      return rows.map((e) => ({
        id: e.id,
        name: e.displayName,
        jobTitle: e.profile?.jobTitle ?? null,
      }));
    });
  }

  /**
   * The branch and service a booking or availability call names, checked
   * against the public definition. Returns what a confirmation needs.
   */
  async assertBookable(branchId: string, serviceId: string, employeeId?: string) {
    return this.run(async (tx, companyId) => {
      const branch = await this.assertPublicBranch(tx, companyId, branchId);
      await this.assertPublicService(tx, companyId, branchId, serviceId);

      if (employeeId) {
        // Same definition as the employee list: another company's person, a
        // non-bookable one, or one who does not provide this service here are
        // all simply not there.
        const employee = await tx.employee.findFirst({
          where: {
            id: employeeId,
            companyId,
            status: 'ACTIVE',
            isBookable: true,
            deletedAt: null,
            services: { some: { companyId, serviceId } },
            branches: { some: { companyId, branchId } },
          },
          select: { id: true },
        });
        if (!employee) throw new ResourceNotFoundError('Employee', employeeId);
      }
      return branch;
    });
  }

  // ---------------------------------------------------------------------------

  private async publicBranches(tx: TenantTx, companyId: string, companyAllows: boolean) {
    const rows = await tx.branch.findMany({
      where: { companyId, status: 'ACTIVE', deletedAt: null },
      select: {
        id: true,
        name: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        district: true,
        phone: true,
        timezoneName: true,
        settings: { select: { allowOnlineBooking: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    return rows
      .filter((b) => b.settings?.allowOnlineBooking ?? companyAllows)
      .map(({ settings: _settings, ...branch }) => toPublicBranch(branch));
  }

  private async assertPublicBranch(tx: TenantTx, companyId: string, branchId: string) {
    const [branch, settings] = await Promise.all([
      tx.branch.findFirst({
        where: { id: branchId, companyId, status: 'ACTIVE', deletedAt: null },
        select: {
          id: true,
          name: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          district: true,
          phone: true,
          timezoneName: true,
          settings: { select: { allowOnlineBooking: true } },
        },
      }),
      tx.companySettings.findFirst({ where: { companyId }, select: { allowOnlineBooking: true } }),
    ]);

    const allows = branch?.settings?.allowOnlineBooking ?? settings?.allowOnlineBooking ?? true;
    if (!branch || !allows) throw new ResourceNotFoundError('Branch', branchId);

    const { settings: _settings, ...rest } = branch;
    return toPublicBranch(rest);
  }

  private async assertPublicService(
    tx: TenantTx,
    companyId: string,
    branchId: string,
    serviceId: string,
  ) {
    const offered = await tx.serviceBranch.findFirst({
      where: {
        companyId,
        branchId,
        serviceId,
        isAvailable: true,
        service: { companyId, status: 'ACTIVE', isOnlineBookable: true, deletedAt: null },
      },
      select: { serviceId: true },
    });
    if (!offered) throw new ResourceNotFoundError('Service', serviceId);
  }

  private run<T>(fn: (tx: TenantTx, companyId: string) => Promise<T>): Promise<T> {
    const companyId = this.context.requireCompanyId('public catalogue');
    return this.db.run((tx) => fn(tx, companyId), 'public-catalog');
  }
}

function toPublicBranch(b: {
  id: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  district: string | null;
  phone: string | null;
  timezoneName: string;
}) {
  return {
    id: b.id,
    name: b.name,
    address: [b.addressLine1, b.addressLine2, b.district, b.city].filter(Boolean).join(', ') || null,
    phone: b.phone,
    timezone: b.timezoneName,
  };
}
