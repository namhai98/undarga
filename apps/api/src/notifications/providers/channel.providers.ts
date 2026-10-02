import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config';
import { MockNotificationProvider } from './mock.provider';

/**
 * The three channels, each its own provider. Today all three are mocks; a real
 * vendor replaces one of these classes (or is registered after it in
 * `NotificationsModule`) and nothing else changes.
 *
 * Address validation lives here because it is the vendor's rule, not the
 * business's: what counts as a deliverable phone number is whatever the SMS
 * gateway accepts.
 */

/** Deliberately simple: one @, a dot in the domain, no spaces. Vendors verify the rest. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** E.164 after removing spaces, dashes and brackets: +, then 8–15 digits. */
const E164 = /^\+[1-9]\d{7,14}$/;

/** A device token as FCM/APNs issue them: long, URL-safe. */
const DEVICE_TOKEN = /^[A-Za-z0-9:_\-.]{32,4096}$/;

@Injectable()
export class EmailNotificationProvider extends MockNotificationProvider {
  readonly name = 'mock-email';
  readonly channel = 'EMAIL' as const;

  constructor(config: AppConfig) {
    super(config, EmailNotificationProvider.name);
  }

  isValidAddress(address: string): boolean {
    return address.length <= 320 && EMAIL.test(address);
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
    return E164.test(address.replace(/[\s\-()]/g, ''));
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
    return DEVICE_TOKEN.test(address);
  }
}
