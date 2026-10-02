import { ResourceNotFoundError } from '../common/errors';
import type { TenantTx } from '../database/tenant-prisma.service';

/**
 * What one service costs for one booking — the single rule, used by the
 * Appointment Engine when it writes a booking and by the promotion validator
 * when it previews one. Two copies of this rule is how a customer is quoted one
 * price and charged another.
 *
 * Most specific wins: an employee's own price for the service, then the
 * branch's, then the service's list price.
 */
export function bookingPrice(prices: {
  servicePriceMinor: bigint;
  branchOverrideMinor: bigint | null;
  employeeOverrideMinor: bigint | null;
}): bigint {
  return prices.employeeOverrideMinor ?? prices.branchOverrideMinor ?? prices.servicePriceMinor;
}

/**
 * Load the price for a service at a branch, optionally with a named employee,
 * checking ownership on the way: the service must be offered and available at
 * the branch, and the employee must provide it there. Anything else — including
 * another company's ids — is a 404.
 */
export async function loadBookingPrice(
  tx: TenantTx,
  companyId: string,
  input: { serviceId: string; branchId: string; employeeId?: string },
) {
  const offered = await tx.serviceBranch.findFirst({
    where: {
      companyId,
      serviceId: input.serviceId,
      branchId: input.branchId,
      isAvailable: true,
      service: { companyId, deletedAt: null, status: 'ACTIVE' },
      branch: { companyId, deletedAt: null },
    },
    select: {
      priceOverrideMinor: true,
      service: {
        select: { id: true, name: true, priceMinor: true, currencyCode: true, isOnlineBookable: true },
      },
    },
  });
  if (!offered) throw new ResourceNotFoundError('Service', input.serviceId);

  let employeeOverrideMinor: bigint | null = null;
  if (input.employeeId) {
    const link = await tx.employeeService.findFirst({
      where: {
        companyId,
        employeeId: input.employeeId,
        serviceId: input.serviceId,
        employee: {
          companyId,
          deletedAt: null,
          branches: { some: { companyId, branchId: input.branchId } },
        },
      },
      select: { priceOverrideMinor: true },
    });
    if (!link) throw new ResourceNotFoundError('Employee', input.employeeId);
    employeeOverrideMinor = link.priceOverrideMinor;
  }

  return {
    serviceId: offered.service.id,
    serviceName: offered.service.name,
    currencyCode: offered.service.currencyCode,
    isOnlineBookable: offered.service.isOnlineBookable,
    priceMinor: bookingPrice({
      servicePriceMinor: offered.service.priceMinor,
      branchOverrideMinor: offered.priceOverrideMinor,
      employeeOverrideMinor,
    }),
  };
}
