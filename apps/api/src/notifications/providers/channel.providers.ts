import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config';
import { isValidAddress } from './address-rules';
import { MockNotificationProvider } from './mock.provider';

/**
 * The test doubles, one per channel (`EMAIL_PROVIDER=mock` and friends).
 *
 * They are what the automated suites run against: they record what would have
 * been sent and can be told to fail. They are never registered unless a
 * channel is explicitly configured as `mock`, and env validation refuses that
 * in production — so a mock can no longer stand in for a missing provider and
 * report a message as sent that went nowhere.
 */

@Injectable()
export class EmailNotificationProvider extends MockNotificationProvider {
  readonly name = 'mock-email';
  readonly channel = 'EMAIL' as const;

  constructor(config: AppConfig) {
    super(config, EmailNotificationProvider.name);
  }

  isValidAddress(address: string): boolean {
    return isValidAddress('EMAIL', address);
  }
}

@Injectable()
export class SmsNotificationProvider extends MockNotificationProvider {
  readonly name = 'mock-sms';
  readonly channel = 'SMS' as const;

  constructor(config: AppConfig) {
    super(config, SmsNotificationProvider.name);
  }

  isValidAddress(address: string): boolean {
    return isValidAddress('SMS', address);
  }
}

@Injectable()
export class PushNotificationProvider extends MockNotificationProvider {
  readonly name = 'mock-push';
  readonly channel = 'PUSH' as const;

  constructor(config: AppConfig) {
    super(config, PushNotificationProvider.name);
  }

  isValidAddress(address: string): boolean {
    return isValidAddress('PUSH', address);
  }
}
