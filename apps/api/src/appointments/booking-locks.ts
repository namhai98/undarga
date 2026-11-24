import type { TenantTx } from '../database/tenant-prisma.service';

/**
 * Advisory-lock keys that serialise everything able to change whether an
 * employee or a resource is free at a given time: booking (and rescheduling),
 * approving time off, and blocking a resource. Shared from one place so the
 * keys cannot drift apart — two writers taking different keys would not
 * serialise at all.
 */
export function employeeLockKey(companyId: string, employeeId: string): string {
  return `appt:${companyId}:employee:${employeeId}`;
}

export function resourceLockKey(companyId: string, resourceId: string): string {
  return `appt:${companyId}:resource:${resourceId}`;
}

/**
 * Take transaction-scoped advisory locks, always in sorted order so two
 * writers needing the same pair cannot deadlock.
 */
export async function lockKeys(tx: TenantTx, keys: string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}
