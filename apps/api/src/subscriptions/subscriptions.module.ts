import {
  Global,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AppConfig, ConfigModule } from '../config';
import { DatabaseModule } from '../database/database.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { EntitlementsService } from './entitlements.service';
import { FeatureGuard } from './feature.guard';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import {
  PlatformSubscriptionsController,
  SubscriptionsController,
} from './subscriptions.controller';
import { SubscriptionRepository, SubscriptionsService } from './subscriptions.service';

/** Runs the lifecycle sweep on a timer. Off in tests, which call it directly. */
@Injectable()
export class SubscriptionSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly lifecycle: SubscriptionLifecycleService,
  ) {}

  onApplicationBootstrap(): void {
    const { sweepEnabled, sweepIntervalMs } = this.config.subscriptions;
    if (!sweepEnabled || this.config.app.isTest) return;
    this.timer = setInterval(() => void this.tick(), sweepIntervalMs);
    this.timer.unref();
    this.logger.log(`Subscription sweep every ${sweepIntervalMs} ms.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.lifecycle.sweep();
    } catch (error) {
      this.logger.error(`Subscription sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

/**
 * SaaS subscriptions: plans, trials, plan changes, invoices, entitlements.
 *
 * Global because `EntitlementsService` is consulted by the feature guard and
 * by every service that creates something a plan limits; importing this module
 * into each of them would be noise.
 */
@Global()
@Module({
  imports: [DatabaseModule, ConfigModule, TenancyModule],
  controllers: [SubscriptionsController, PlatformSubscriptionsController],
  providers: [
    EntitlementsService,
    FeatureGuard,
    SubscriptionsService,
    SubscriptionRepository,
    SubscriptionLifecycleService,
    SubscriptionSchedulerService,
  ],
  exports: [EntitlementsService, FeatureGuard, SubscriptionLifecycleService],
})
export class SubscriptionsModule {}
