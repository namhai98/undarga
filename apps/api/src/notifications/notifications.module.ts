import { Module } from '@nestjs/common';
import { ConfigModule } from '../config';
import { DatabaseModule } from '../database/database.module';
import {
  CustomerNotificationPreferencesController,
  NotificationSettingsController,
  NotificationTemplatesController,
} from './notification-admin.controllers';
import { NotificationContextService } from './notification-context.service';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { NotificationEventService } from './notification-event.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import {
  NotificationProvidersController,
  NotificationReceiptsController,
  PlatformNotificationProvidersController,
} from './notification-providers.controller';
import {
  NotificationProviderConfigRepository,
  NotificationProvidersService,
} from './notification-providers.service';
import { NotificationReceiptsRepository } from './notification-receipts.repository';
import { NotificationReceiptsService } from './notification-receipts.service';
import { NotificationReminderService } from './notification-reminder.service';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { NotificationSettingsService } from './notification-settings.service';
import { NotificationTemplatesService } from './notification-templates.service';
import { NotificationTemplateRepository } from './notification.repositories';
import { NotificationWorkerService } from './notification-worker.service';
import { NotificationsController } from './notifications.controller';
import { NotificationRepository, NotificationsService } from './notifications.service';
import {
  EmailNotificationProvider,
  PushNotificationProvider,
  SmsNotificationProvider,
} from './providers/channel.providers';
import { platformNotificationProviders } from './providers/platform-providers';
import { NotificationProviderRegistry } from './providers/provider.registry';

/**
 *     business write ─(same transaction)→ outbox_event
 *     reminder sweep ─────────────────────→ outbox_event
 *                                              ↓  NotificationDispatcherService
 *                                          notification (PENDING)
 *                                              ↓  NotificationWorkerService
 *                                          NotificationProvider (per channel)
 *
 * `NotificationSchedulerService` turns the handle on a timer.
 *
 * ---------------------------------------------------------------------------
 * WHO SENDS
 * ---------------------------------------------------------------------------
 *
 * `NOTIFICATION_PROVIDERS` holds the PLATFORM's provider per channel, chosen
 * from the environment (platform-providers.ts): SendGrid / Twilio for real
 * delivery, `log` in development, `mock` in tests, or nothing at all (`none`).
 * A company may instead use its own account per channel
 * (NotificationProvidersService); the worker picks that one when enabled.
 * Delivery receipts (NotificationReceiptsService) are the only way a message
 * becomes DELIVERED. See docs/NOTIFICATION-PROVIDERS.md.
 *
 * `NotificationEventService` is exported: any module with something worth
 * telling somebody about emits through it. The rest of the pipeline is nobody
 * else's business.
 */
@Module({
  imports: [DatabaseModule, ConfigModule],
  controllers: [
    NotificationsController,
    NotificationSettingsController,
    NotificationTemplatesController,
    CustomerNotificationPreferencesController,
    NotificationProvidersController,
    PlatformNotificationProvidersController,
    NotificationReceiptsController,
  ],
  providers: [
    NotificationEventService,
    NotificationContextService,
    NotificationDispatcherService,
    NotificationWorkerService,
    NotificationReminderService,
    NotificationSchedulerService,
    NotificationsService,
    NotificationRepository,
    NotificationSettingsService,
    NotificationTemplatesService,
    NotificationTemplateRepository,
    NotificationPreferencesService,
    NotificationProviderRegistry,
    NotificationProvidersService,
    NotificationProviderConfigRepository,
    NotificationReceiptsService,
    NotificationReceiptsRepository,
    EmailNotificationProvider,
    SmsNotificationProvider,
    PushNotificationProvider,
    platformNotificationProviders,
  ],
  exports: [NotificationEventService, NotificationSchedulerService],
})
export class NotificationsModule {}
