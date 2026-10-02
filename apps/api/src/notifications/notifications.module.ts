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
import { NOTIFICATION_PROVIDERS } from './providers/notification-provider';
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
 * THE PROVIDER LIST IS AN ARRAY
 * ---------------------------------------------------------------------------
 *
 * `NOTIFICATION_PROVIDERS` holds one provider per channel. Adding a real
 * vendor is one entry here — registered after the mock, it takes over that
 * channel (the registry is last-wins) without a conditional anywhere. Today
 * all three are mocks: nothing is delivered, which is the stated scope.
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
    EmailNotificationProvider,
    SmsNotificationProvider,
    PushNotificationProvider,
    {
      provide: NOTIFICATION_PROVIDERS,
      useFactory: (
        email: EmailNotificationProvider,
        sms: SmsNotificationProvider,
        push: PushNotificationProvider,
      ) => [email, sms, push],
      inject: [EmailNotificationProvider, SmsNotificationProvider, PushNotificationProvider],
    },
  ],
  exports: [NotificationEventService, NotificationSchedulerService],
})
export class NotificationsModule {}
