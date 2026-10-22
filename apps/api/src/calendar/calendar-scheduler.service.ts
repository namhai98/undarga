import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AppConfig } from '../config';
import { CalendarSyncService } from './calendar-sync.service';

/**
 * Turns the calendar handle on a timer: due sync jobs, then calendars whose
 * busy periods are stale. In-process and database-backed like the
 * notification worker — Redis stays optional. Ticks never overlap, and every
 * stage claims its work, so several API instances may all run it.
 */
@Injectable()
export class CalendarSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CalendarSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly sync: CalendarSyncService,
  ) {}

  onApplicationBootstrap(): void {
    const { syncEnabled, syncIntervalMs } = this.config.calendar;
    if (!syncEnabled || this.config.app.isTest) return;
    this.timer = setInterval(() => void this.tick(), syncIntervalMs);
    this.timer.unref();
    this.logger.log(`Calendar sync polling every ${syncIntervalMs} ms.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(options: { companyId?: string } = {}) {
    const events = await this.sync.processDue(options);
    const busy = await this.sync.refreshBusy(options);
    return { ...events, busyRefreshed: busy.refreshed, busyFailed: busy.failed };
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(`Calendar tick failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
