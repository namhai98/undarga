import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppConfig } from '../config';
import { PlatformPrismaService } from '../database/platform-prisma.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import { CalendarAccessService, type ConnectionRef } from './calendar-access.service';
import { LIVE_APPOINTMENT_STATUSES } from './calendar-sync.queue';
import { CalendarProviderError, type CalendarEventInput } from './providers/calendar-provider';

/** Backoff after a retryable failure, by attempt. Then FAILED. */
export const SYNC_BACKOFF_SECONDS = [60, 300, 900, 3600];
export const MAX_SYNC_ATTEMPTS = SYNC_BACKOFF_SECONDS.length + 1;
/** A RUNNING job older than this belongs to a worker that died. */
const STALE_RUNNING_MS = 5 * 60_000;
/** Busy periods are read for this window. */
const BUSY_PAST_MS = 24 * 60 * 60_000;
const BUSY_AHEAD_MS = 60 * 24 * 60 * 60_000;
const MAX_BUSY_BLOCKS = 2000;
/** After a failed busy read, wait this long before trying that calendar again. */
const BUSY_ERROR_BACKOFF_MS = 5 * 60_000;

interface Outcome {
  /** A provider outage or throttle: the job should run again later. */
  retryable: boolean;
  error: string | null;
}

type AppointmentRow = NonNullable<Awaited<ReturnType<CalendarSyncService['loadAppointment']>>>;

/**
 * One-way synchronisation: appointments → external calendars, plus reading
 * busy periods back for availability. Nothing read from a calendar ever
 * changes an appointment.
 *
 * ---------------------------------------------------------------------------
 * RECONCILE, DON'T REPLAY
 * ---------------------------------------------------------------------------
 *
 * A job says "this appointment changed", not what changed. The worker reads
 * the appointment as it is NOW and makes each connected calendar match:
 *
 *   live (pending/confirmed/checked-in/in progress), or completed when the
 *   connection keeps completed ones   → the event exists with current details
 *   anything else, gone, reassigned to another employee, or the calendar was
 *   switched                          → the event is deleted
 *
 * So a retry, a duplicate job, or two changes in quick succession all converge
 * on the same result; and creates use a deterministic id, so a create whose
 * answer was lost is adopted rather than duplicated.
 *
 * Reads that discover work cross tenants (platform connection, like the
 * notification worker); every write re-enters the row's company.
 */
@Injectable()
export class CalendarSyncService {
  private readonly logger = new Logger(CalendarSyncService.name);

  constructor(
    private readonly platformDb: PlatformPrismaService,
    private readonly db: TenantPrismaService,
    private readonly access: CalendarAccessService,
    private readonly config: AppConfig,
  ) {}

  // ===========================================================================
  // Event synchronisation
  // ===========================================================================

  async processDue(options: { companyId?: string; limit?: number } = {}) {
    const now = new Date();
    const scope = options.companyId ? { companyId: options.companyId } : {};

    await this.platformDb.calendarSyncJob.updateMany({
      where: {
        ...scope,
        status: 'RUNNING',
        lockedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) },
      },
      data: { status: 'PENDING', lockedAt: null },
    });

    const due = await this.platformDb.calendarSyncJob.findMany({
      where: { ...scope, status: 'PENDING', nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: 'asc' },
      take: options.limit ?? 50,
      select: { id: true, companyId: true, appointmentId: true, version: true, attempts: true },
    });

    let synced = 0;
    let failed = 0;
    let skipped = 0;
    for (const job of due) {
      const claimed = await this.platformDb.calendarSyncJob.updateMany({
        where: { id: job.id, status: 'PENDING' },
        data: { status: 'RUNNING', lockedAt: new Date() },
      });
      if (claimed.count === 0) {
        skipped += 1;
        continue;
      }

      let outcome: Outcome;
      try {
        outcome = await this.syncAppointment(job.companyId, job.appointmentId);
      } catch (error) {
        // Not a provider answer (database, a bug): retry, and log without data.
        this.logger.error(`Calendar sync job ${job.id} crashed: ${(error as Error).message}`);
        outcome = { retryable: true, error: 'Internal error while syncing.' };
      }

      const attempts = job.attempts + 1;
      const giveUp = outcome.retryable && attempts >= MAX_SYNC_ATTEMPTS;
      const final: Prisma.CalendarSyncJobUpdateManyMutationInput = outcome.retryable
        ? giveUp
          ? { status: 'FAILED', attempts, lastError: outcome.error, lockedAt: null }
          : {
              status: 'PENDING',
              attempts,
              lastError: outcome.error,
              lockedAt: null,
              nextAttemptAt: new Date(Date.now() + SYNC_BACKOFF_SECONDS[attempts - 1]! * 1000),
            }
        : { status: 'DONE', attempts, lastError: outcome.error, lockedAt: null };

      // Only if nothing changed while it ran; otherwise run it again now.
      const finished = await this.platformDb.calendarSyncJob.updateMany({
        where: { id: job.id, version: job.version },
        data: final,
      });
      if (finished.count === 0) {
        await this.platformDb.calendarSyncJob.updateMany({
          where: { id: job.id },
          data: { status: 'PENDING', lockedAt: null, nextAttemptAt: new Date() },
        });
      }
      if (outcome.retryable) failed += 1;
      else synced += 1;
    }

    if (synced > 0 || failed > 0) {
      this.logger.log(
        `Calendar sync: ${synced} done, ${failed} to retry, ${skipped} claimed elsewhere.`,
      );
    }
    return { synced, failed, skipped };
  }

  /** Make every connected calendar match this appointment as it is now. */
  async syncAppointment(companyId: string, appointmentId: string): Promise<Outcome> {
    const { appointment, links, connections } = await this.db.runInCompany(
      companyId,
      async (tx) => {
        const appointment = await this.loadAppointment(tx, companyId, appointmentId);
        const employeeIds = [
          ...new Set(
            (appointment?.items ?? []).map((i) => i.employeeId).filter((id): id is string => !!id),
          ),
        ];
        const [links, connections] = await Promise.all([
          tx.calendarEventLink.findMany({
            where: { companyId, appointmentId },
            include: { connection: true },
          }),
          employeeIds.length
            ? tx.calendarConnection.findMany({
                where: {
                  companyId,
                  employeeId: { in: employeeIds },
                  employee: { deletedAt: null },
                },
              })
            : Promise.resolve([]),
        ]);
        return { appointment, links, connections };
      },
    );

    const desired = new Map(
      connections
        .filter(
          (c) =>
            c.status === 'ACTIVE' &&
            appointment &&
            belongsOnCalendar(appointment.status, c.syncCompleted),
        )
        .map((c) => [c.id, c]),
    );

    let retryable = false;
    const errors: string[] = [];
    const record = (error: unknown, connectionId: string) => {
      if (error instanceof CalendarProviderError) {
        if (error.retryable) retryable = true;
        errors.push(error.message);
        return error.message;
      }
      retryable = true;
      errors.push('Unexpected error.');
      this.logger.error(`Calendar connection ${connectionId}: ${(error as Error).message}`);
      return 'Unexpected error.';
    };

    // 1. Events that should no longer exist.
    for (const link of links) {
      const connection = link.connection;
      const wanted = desired.has(connection.id) && link.calendarId === connection.calendarId;
      if (wanted) continue;
      if (connection.status !== 'ACTIVE') continue; // cannot act until reconnected
      try {
        await this.access.withToken(ref(connection), (provider, token) =>
          provider.deleteEvent(token, link.calendarId, link.externalEventId),
        );
        await this.db.runInCompany(companyId, (tx) =>
          tx.calendarEventLink.deleteMany({ where: { id: link.id, companyId } }),
        );
        await this.markSynced(companyId, connection.id);
      } catch (error) {
        await this.linkError(companyId, link.id, connection.id, record(error, connection.id));
      }
    }

    // 2. Events that should exist, with these details.
    for (const connection of desired.values()) {
      const event = eventFor(
        appointment!,
        connection.employeeId,
        connection.id,
        connection.calendarId,
      );
      if (!event) continue;
      const hash = contentHash(event);
      const link = links.find(
        (l) => l.connectionId === connection.id && l.calendarId === connection.calendarId,
      );
      if (link && link.contentHash === hash && !link.lastError) continue;

      try {
        const externalEventId = await this.access.withToken(
          ref(connection),
          async (provider, token) => {
            if (link) {
              try {
                await provider.updateEvent(
                  token,
                  connection.calendarId,
                  link.externalEventId,
                  event,
                );
                return link.externalEventId;
              } catch (error) {
                // Deleted by hand in the calendar: put it back.
                if (!(error instanceof CalendarProviderError) || error.kind !== 'NOT_FOUND')
                  throw error;
              }
            }
            return provider.createEvent(token, connection.calendarId, event);
          },
        );
        const now = new Date();
        // Update-or-create rather than upsert: the tenant-scope guard wants
        // companyId in every filter, and jobs for one appointment never run
        // concurrently, so the two steps cannot race.
        await this.db.runInCompany(companyId, async (tx) => {
          const updated = await tx.calendarEventLink.updateMany({
            where: { companyId, connectionId: connection.id, appointmentId },
            data: {
              calendarId: connection.calendarId,
              externalEventId,
              contentHash: hash,
              lastSyncedAt: now,
              lastError: null,
              lastErrorAt: null,
            },
          });
          if (updated.count === 0) {
            await tx.calendarEventLink.create({
              data: {
                companyId,
                connectionId: connection.id,
                appointmentId,
                calendarId: connection.calendarId,
                externalEventId,
                contentHash: hash,
                lastSyncedAt: now,
              },
            });
          }
        });
        await this.markSynced(companyId, connection.id);
      } catch (error) {
        const message = record(error, connection.id);
        if (link) await this.linkError(companyId, link.id, connection.id, message);
        else await this.connectionError(companyId, connection.id, message);
      }
    }

    return { retryable, error: errors.length ? errors.join('; ').slice(0, 512) : null };
  }

  loadAppointment(tx: TenantTx, companyId: string, appointmentId: string) {
    return tx.appointment.findFirst({
      where: { id: appointmentId, companyId },
      select: {
        id: true,
        appointmentNumber: true,
        status: true,
        branch: {
          select: {
            name: true,
            timezoneName: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
          },
        },
        items: {
          orderBy: { sequence: 'asc' },
          select: {
            employeeId: true,
            startsAt: true,
            endsAt: true,
            snapshot: true,
            service: { select: { name: true } },
          },
        },
      },
    });
  }

  // ===========================================================================
  // Busy periods
  // ===========================================================================

  /**
   * Re-read busy periods for calendars that are due. Each calendar's blocks
   * are replaced in one transaction, so availability never sees half a set.
   * A failed read keeps the previous blocks (the best information there is)
   * and is not retried for a few minutes.
   */
  async refreshBusy(options: { companyId?: string; connectionId?: string; limit?: number } = {}) {
    const now = Date.now();
    const staleBefore = new Date(now - this.config.calendar.busyRefreshMinutes * 60_000);
    const connections = await this.platformDb.calendarConnection.findMany({
      where: {
        ...(options.companyId ? { companyId: options.companyId } : {}),
        ...(options.connectionId ? { id: options.connectionId } : {}),
        status: 'ACTIVE',
        useForAvailability: true,
        OR: [{ busySyncedAt: null }, { busySyncedAt: { lt: staleBefore } }],
        AND: [
          {
            OR: [
              { lastErrorAt: null },
              { lastErrorAt: { lt: new Date(now - BUSY_ERROR_BACKOFF_MS) } },
              ...(options.connectionId ? [{ id: options.connectionId }] : []),
            ],
          },
        ],
      },
      take: options.limit ?? 20,
    });

    let refreshed = 0;
    let failed = 0;
    for (const connection of connections) {
      try {
        const periods = await this.access.withToken(ref(connection), (provider, token) =>
          provider.listBusy(token, connection.calendarId, {
            from: new Date(now - BUSY_PAST_MS),
            to: new Date(now + BUSY_AHEAD_MS),
            calendarTimeZone: connection.calendarTimeZone,
          }),
        );
        await this.db.runInCompany(connection.companyId, async (tx) => {
          await tx.calendarBusyBlock.deleteMany({
            where: { companyId: connection.companyId, connectionId: connection.id },
          });
          if (periods.length) {
            await tx.calendarBusyBlock.createMany({
              data: periods.slice(0, MAX_BUSY_BLOCKS).map((p) => ({
                companyId: connection.companyId,
                connectionId: connection.id,
                employeeId: connection.employeeId,
                startsAt: p.start,
                endsAt: p.end,
              })),
            });
          }
          await tx.calendarConnection.updateMany({
            where: { id: connection.id, companyId: connection.companyId, status: 'ACTIVE' },
            data: { busySyncedAt: new Date(), lastError: null, lastErrorAt: null },
          });
        });
        refreshed += 1;
      } catch (error) {
        failed += 1;
        const message =
          error instanceof CalendarProviderError ? error.message : 'Unexpected error.';
        if (!(error instanceof CalendarProviderError)) {
          this.logger.error(
            `Busy refresh for ${connection.id} crashed: ${(error as Error).message}`,
          );
        }
        await this.connectionError(connection.companyId, connection.id, `Busy times: ${message}`);
      }
    }
    return { refreshed, failed };
  }

  // ===========================================================================
  // Bookkeeping
  // ===========================================================================

  private markSynced(companyId: string, connectionId: string) {
    return this.db.runInCompany(companyId, (tx) =>
      tx.calendarConnection.updateMany({
        where: { id: connectionId, companyId, status: 'ACTIVE' },
        data: { lastSyncAt: new Date(), lastError: null, lastErrorAt: null },
      }),
    );
  }

  private async linkError(
    companyId: string,
    linkId: string,
    connectionId: string,
    message: string,
  ) {
    await this.db.runInCompany(companyId, (tx) =>
      tx.calendarEventLink.updateMany({
        where: { id: linkId, companyId },
        data: { lastError: message.slice(0, 512), lastErrorAt: new Date() },
      }),
    );
    await this.connectionError(companyId, connectionId, message);
  }

  private connectionError(companyId: string, connectionId: string, message: string) {
    return this.db.runInCompany(companyId, (tx) =>
      tx.calendarConnection.updateMany({
        // NEEDS_REAUTH keeps its own, more useful message.
        where: { id: connectionId, companyId, status: 'ACTIVE' },
        data: { lastError: message.slice(0, 512), lastErrorAt: new Date() },
      }),
    );
  }
}

function ref(connection: {
  id: string;
  companyId: string;
  employeeId: string;
  provider: string;
  credentials: string;
  accessTokenExpiresAt: Date | null;
}): ConnectionRef {
  return {
    id: connection.id,
    companyId: connection.companyId,
    employeeId: connection.employeeId,
    provider: connection.provider,
    credentials: connection.credentials,
    accessTokenExpiresAt: connection.accessTokenExpiresAt,
  };
}

export function belongsOnCalendar(status: string, syncCompleted: boolean): boolean {
  return (
    (LIVE_APPOINTMENT_STATUSES as readonly string[]).includes(status) ||
    (status === 'COMPLETED' && syncCompleted)
  );
}

const STATUS_TEXT: Record<string, string> = {
  PENDING: 'Awaiting confirmation',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
};

/**
 * The event for one employee's part of an appointment.
 *
 * Deliberately minimal: service, time, branch and the booking number. No
 * customer name, phone, email or notes — a calendar is shared, synced to
 * phones and read by assistants, and it is not this system's to fill with
 * customer data. The booking number leads back to the details in the app.
 */
export function eventFor(
  appointment: AppointmentRow,
  employeeId: string,
  connectionId: string,
  calendarId: string,
): CalendarEventInput | null {
  const items = appointment.items.filter((i) => i.employeeId === employeeId);
  if (items.length === 0) return null;
  const services = [
    ...new Set(
      items.map((i) => {
        const snapshot = (i.snapshot ?? {}) as { serviceName?: unknown };
        return typeof snapshot.serviceName === 'string' ? snapshot.serviceName : i.service.name;
      }),
    ),
  ];
  const branch = appointment.branch;
  const location = [branch.name, branch.addressLine1, branch.addressLine2, branch.city]
    .filter((part): part is string => !!part && part.trim() !== '')
    .join(', ');
  return {
    idempotencyKey: createHash('sha256')
      .update(`${connectionId}:${appointment.id}:${calendarId}`)
      .digest('hex')
      .slice(0, 40),
    appointmentId: appointment.id,
    summary: `${services.join(', ')} · ${branch.name}`.slice(0, 250),
    description:
      `Booking ${appointment.appointmentNumber} — ${STATUS_TEXT[appointment.status] ?? appointment.status}.\n` +
      `Branch: ${branch.name}.\n\n` +
      'Added by Undarga. Customer details are in the app; changes made here are not synced back.',
    location: location || null,
    start: new Date(Math.min(...items.map((i) => i.startsAt.getTime()))),
    end: new Date(Math.max(...items.map((i) => i.endsAt.getTime()))),
    timeZone: branch.timezoneName,
  };
}

export function contentHash(event: CalendarEventInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        event.summary,
        event.description,
        event.location,
        event.start.toISOString(),
        event.end.toISOString(),
        event.timeZone,
      ]),
    )
    .digest('hex');
}
