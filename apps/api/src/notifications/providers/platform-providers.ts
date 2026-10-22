import type { Provider } from '@nestjs/common';
import { AppConfig } from '../../config';
import {
  EmailNotificationProvider,
  PushNotificationProvider,
  SmsNotificationProvider,
} from './channel.providers';
import { LogNotificationProvider } from './log.provider';
import { NOTIFICATION_PROVIDERS, type NotificationProvider } from './notification-provider';
import { SendGridEmailProvider } from './sendgrid.provider';
import { TwilioSmsProvider } from './twilio.provider';

/**
 * The platform's provider per channel, from the environment. `none` registers
 * nothing for that channel — so nothing is sent on it, and nothing pretends
 * otherwise. Env validation has already required each real provider's secrets
 * and refused `log`/`mock` in production.
 */
export const platformNotificationProviders: Provider = {
  provide: NOTIFICATION_PROVIDERS,
  useFactory: (
    config: AppConfig,
    mockEmail: EmailNotificationProvider,
    mockSms: SmsNotificationProvider,
    mockPush: PushNotificationProvider,
  ): NotificationProvider[] => {
    const settings = config.notificationProviders;
    const providers: NotificationProvider[] = [];

    switch (settings.email.provider) {
      case 'sendgrid':
        providers.push(
          new SendGridEmailProvider({
            apiKey: settings.email.sendgridApiKey!,
            fromAddress: settings.email.fromAddress!,
            fromName: settings.email.fromName,
          }),
        );
        break;
      case 'log':
        providers.push(new LogNotificationProvider('EMAIL'));
        break;
      case 'mock':
        providers.push(mockEmail);
        break;
    }

    switch (settings.sms.provider) {
      case 'twilio':
        providers.push(
          new TwilioSmsProvider({
            accountSid: settings.sms.twilioAccountSid!,
            authToken: settings.sms.twilioAuthToken!,
            fromNumber: settings.sms.twilioFromNumber,
            messagingServiceSid: settings.sms.twilioMessagingServiceSid,
          }),
        );
        break;
      case 'log':
        providers.push(new LogNotificationProvider('SMS'));
        break;
      case 'mock':
        providers.push(mockSms);
        break;
    }

    if (settings.push.provider === 'mock') providers.push(mockPush);

    return providers;
  },
  inject: [AppConfig, EmailNotificationProvider, SmsNotificationProvider, PushNotificationProvider],
};
