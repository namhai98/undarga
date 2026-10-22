import { Module } from '@nestjs/common';
import { ConfigModule } from '../config';
import { DatabaseModule } from '../database/database.module';
import { CalendarAccessService } from './calendar-access.service';
import {
  CalendarConnectionRepository,
  CalendarConnectionsService,
} from './calendar-connections.service';
import { CalendarProviderRegistry } from './calendar-provider.registry';
import { CalendarSchedulerService } from './calendar-scheduler.service';
import { CalendarSyncService } from './calendar-sync.service';
import { CalendarController } from './calendar.controller';

/**
 *     appointment change ─(same tx)→ calendar_sync_job ─→ CalendarSyncService ─→ provider events
 *     CalendarSyncService.refreshBusy ─→ calendar_busy_block ─→ AvailabilityRepository
 *
 * Appointments enqueue through the plain `enqueueCalendarSync(tx, …)` function
 * (calendar-sync.queue.ts), so the appointment module does not depend on this
 * one; availability reads `calendar_busy_block` directly.
 */
@Module({
  imports: [DatabaseModule, ConfigModule],
  controllers: [CalendarController],
  providers: [
    CalendarProviderRegistry,
    CalendarAccessService,
    CalendarSyncService,
    CalendarSchedulerService,
    CalendarConnectionsService,
    CalendarConnectionRepository,
  ],
  exports: [CalendarSchedulerService],
})
export class CalendarModule {}
