import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PlatformPrismaService } from '../database/platform-prisma.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { NOTIFICATION_EVENTS, NotificationEventService } from './notification-event.service';

interface DueReminder {
  appointment_id: string;
  company_id: string;
  starts_at: Date;
  offset_minutes: number;
}

/**
 * Appointment reminders, at each company's configured offsets
 * (`company_settings.reminder_offsets_minutes`, default 24h and 2h).
 *
 * ---------------------------------------------------------------------------
 * A SWEEP, NOT A SCHEDULE
 * ---------------------------------------------------------------------------
 *
 * Nothing is scheduled when a booking is made. Each tick asks: which live
 * appointments have reached a reminder moment they have not been reminded
 * for? That one question stays right through everything that would make a
 * precomputed schedule wrong — a cancellation (no longer live), a reschedule
 * (a new appointment row with a new start time), a company changing its
 * offsets or switching reminders off.
 *
 * A reminder is due for offset `o` when
 *
 *     starts_at - o <= now < starts_at        — its moment has come, not passed
 *     created_at    <  starts_at - o          — the booking existed by then
 *
 * The second line is what stops a booking made two hours out from getting a
 * "24 hours to go" message the moment it is created.
 *
 * ---------------------------------------------------------------------------
 * NO DUPLICATES
 * ---------------------------------------------------------------------------
 *
 * Each reminder is recorded in `appointment_reminder`, unique on
 * (appointment, offset, starts_at), in the SAME transaction as its outbox
 * event. Two sweeps racing both try the insert; one wins, the other gets a
 * unique violation and emits nothing. The notification's dedupe key is built
 * from the same three values, as a second guard.
 */
@Injectable()
export class NotificationReminderService {
  private readonly logger = new Logger(NotificationReminderService.name);

  constructor(
    private readonly platformDb: PlatformPrismaService,
    private readonly db: TenantPrismaService,
    private readonly events: NotificationEventService,
  ) {}

  async scheduleDue(
    options: { now?: Date; companyId?: string; limit?: number } = {},
  ): Promise<{ scheduled: number; duplicates: number }> {
    const now = options.now ?? new Date();
    const companyFilter = options.companyId
      ? Prisma.sql`AND a.company_id = ${options.companyId}::uuid`
      : Prisma.empty;

    // Cross-tenant by nature: the sweep cannot be told which company has a
    // reminder due. Every write below re-enters that company's transaction.
    const due = await this.platformDb.$queryRaw<DueReminder[]>`
      SELECT a.id AS appointment_id, a.company_id, a.starts_at, o.offset_minutes
        FROM appointment a
        JOIN company_settings s ON s.company_id = a.company_id
       CROSS JOIN LATERAL unnest(s.reminder_offsets_minutes) AS o(offset_minutes)
       WHERE s.reminders_enabled
         AND a.status IN ('PENDING', 'CONFIRMED')
         AND a.starts_at > ${now}
         AND a.starts_at - make_interval(mins => o.offset_minutes) <= ${now}
         AND a.created_at < a.starts_at - make_interval(mins => o.offset_minutes)
         ${companyFilter}
         AND NOT EXISTS (
               SELECT 1 FROM appointment_reminder r
                WHERE r.company_id = a.company_id
                  AND r.appointment_id = a.id
                  AND r.offset_minutes = o.offset_minutes
                  AND r.starts_at = a.starts_at)
       ORDER BY a.starts_at
       LIMIT ${options.limit ?? 200}
    `;

    let scheduled = 0;
    let duplicates = 0;

    for (const row of due) {
      const startsAt = new Date(row.starts_at);
      const offsetMinutes = Number(row.offset_minutes);
      try {
        await this.db.runInCompany(row.company_id, async (tx) => {
          await tx.appointmentReminder.create({
            data: {
              companyId: row.company_id,
              appointmentId: row.appointment_id,
              offsetMinutes,
              startsAt,
              remindAt: new Date(startsAt.getTime() - offsetMinutes * 60_000),
            },
          });
          await this.events.emitWithin(
            tx,
            row.company_id,
            NOTIFICATION_EVENTS.APPOINTMENT_REMINDER,
            {
              appointmentId: row.appointment_id,
              offsetMinutes,
              dedupeBase: `reminder:${row.appointment_id}:${offsetMinutes}:${startsAt.toISOString()}`,
            },
          );
        });
        scheduled += 1;
      } catch (error) {
        // Another sweep got there first. The loser's transaction rolled back
        // whole, so it emitted nothing.
        if ((error as { code?: string }).code === 'P2002') {
          duplicates += 1;
          continue;
        }
        this.logger.error(
          `Could not schedule reminder for appointment ${row.appointment_id}: ${(error as Error).message}`,
        );
      }
    }

    return { scheduled, duplicates };
  }
}
