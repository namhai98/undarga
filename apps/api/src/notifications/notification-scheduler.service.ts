import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AppConfig } from '../config';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { NotificationReminderService } from './notification-reminder.service';
import { NotificationWorkerService } from './notification-worker.service';

export interface NotificationRunResult {
  reminders: number;
  dispatched: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * Turns the handle, on a timer:
 *
 *     reminders due  →  outbox  →  notification rows  →  providers
 *
 * ---------------------------------------------------------------------------
 * IN-PROCESS, AND SAFE TO RUN MANY TIMES
 * ---------------------------------------------------------------------------
 *
 * There is no separate worker process and no BullMQ (see
 * NotificationEventService). Each API instance polls every
 * `NOTIFICATION_WORKER_INTERVAL_MS`; several instances running at once is
 * fine, because every stage claims its work — a unique key for reminders, a
 * dedupe key for notifications, a conditional UPDATE before sending. Ticks do
 * not overlap within one process.
 *
 * Off in tests: they call `runOnce` (or each stage) directly, so what runs is
 * decided by the test, not by a timer racing it.
 */
@Injectable()
export class NotificationSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<NotificationRunResult> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly reminders: NotificationReminderService,
    private readonly dispatcher: NotificationDispatcherService,
    private readonly worker: NotificationWorkerService,
  ) {}

  onApplicationBootstrap(): void {
    const { workerEnabled, workerIntervalMs } = this.config.notifications;
    if (!workerEnabled || this.config.app.isTest) {
      this.logger.log('Notification worker disabled; call POST /notifications/run to process.');
      return;
    }
    this.timer = setInterval(() => void this.tick(), workerIntervalMs);
    // Never the reason the process stays alive.
    this.timer.unref();
    this.logger.log(`Notification worker polling every ${workerIntervalMs} ms.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass of every stage. `companyId` confines it to one company — the
   * manual run endpoint must not process other tenants' queues.
   */
  async runOnce(options: { companyId?: string } = {}): Promise<NotificationRunResult> {
    const { scheduled } = await this.reminders.scheduleDue({ companyId: options.companyId });
    const { dispatched, failed: dispatchFailed } = await this.dispatcher.dispatchPending({
      companyId: options.companyId,
    });
    const { sent, failed, skipped } = await this.worker.processDue({
      companyId: options.companyId,
    });
    return { reminders: scheduled, dispatched, sent, failed: failed + dispatchFailed, skipped };
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = this.runOnce();
    try {
      await this.running;
    } catch (error) {
      // A tick that throws (database away, say) is logged and the next one
      // tries again. Nothing is lost: all state is in the tables.
      this.logger.error(`Notification tick failed: ${(error as Error).message}`);
    } finally {
      this.running = null;
    }
  }
}
