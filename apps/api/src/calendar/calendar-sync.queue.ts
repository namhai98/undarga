import type { TenantTx } from '../database/tenant-prisma.service';

/**
 * Mark appointments as needing their calendar events reconciled.
 *
 * Called in the SAME transaction as the appointment change, so the job exists
 * exactly when the change does — and costs the booking one INSERT, never a
 * provider call. A company with no calendar connection (and no events left to
 * clean up) gets nothing written at all.
 *
 * One row per appointment. A change while a job is queued or running bumps
 * `version` instead of adding a second job; the worker then runs it again
 * after finishing, so the last change always wins and no two workers sync the
 * same appointment at once.
 */
export async function enqueueCalendarSync(
  tx: TenantTx,
  companyId: string,
  appointmentIds: readonly string[],
): Promise<number> {
  const ids = [...new Set(appointmentIds)];
  if (ids.length === 0) return 0;
  return tx.$executeRaw`
    INSERT INTO calendar_sync_job
      (id, company_id, appointment_id, status, version, attempts, next_attempt_at, created_at, updated_at)
    SELECT gen_random_uuid(), ${companyId}::uuid, a.id, 'PENDING', 1, 0, now(), now(), now()
      FROM unnest(${ids}::uuid[]) AS a(id)
     WHERE EXISTS (SELECT 1 FROM calendar_connection c WHERE c.company_id = ${companyId}::uuid)
        OR EXISTS (SELECT 1 FROM calendar_event_link l
                    WHERE l.company_id = ${companyId}::uuid AND l.appointment_id = a.id)
    ON CONFLICT (company_id, appointment_id) DO UPDATE SET
      version         = calendar_sync_job.version + 1,
      attempts        = 0,
      last_error      = NULL,
      next_attempt_at = now(),
      status          = CASE WHEN calendar_sync_job.status = 'RUNNING' THEN 'RUNNING' ELSE 'PENDING' END,
      updated_at      = now()`;
}

/** Statuses whose appointment belongs on the employee's calendar. */
export const LIVE_APPOINTMENT_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
] as const;

/**
 * Queue every appointment of one employee that could be on their calendar —
 * upcoming live ones, plus any this connection already has events for. Used
 * after connecting, reconnecting, changing calendar, or a manual resync.
 */
export async function enqueueEmployeeBackfill(
  tx: TenantTx,
  companyId: string,
  employeeId: string,
  connectionId: string | null,
): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [upcoming, linked] = await Promise.all([
    tx.appointment.findMany({
      where: {
        companyId,
        endsAt: { gte: since },
        status: { in: [...LIVE_APPOINTMENT_STATUSES, 'COMPLETED'] },
        items: { some: { companyId, employeeId } },
      },
      select: { id: true },
      orderBy: { startsAt: 'asc' },
      take: 500,
    }),
    connectionId
      ? tx.calendarEventLink.findMany({
          where: { companyId, connectionId },
          select: { appointmentId: true },
          take: 500,
        })
      : Promise.resolve([]),
  ]);
  return enqueueCalendarSync(tx, companyId, [
    ...upcoming.map((a) => a.id),
    ...linked.map((l) => l.appointmentId),
  ]);
}
