import type { NotificationChannel } from '@prisma/client';

/**
 * What a deliverable address looks like, per channel — shared by every
 * provider so "invalid address" means the same thing whichever one is
 * configured (and whether or not one is). Vendors verify the rest.
 */

/** Deliberately simple: one @, a dot in the domain, no spaces. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** E.164 after removing spaces, dashes and brackets: +, then 8–15 digits. */
const E164 = /^\+[1-9]\d{7,14}$/;

/** A device token as FCM/APNs issue them: long, URL-safe. */
const DEVICE_TOKEN = /^[A-Za-z0-9:_\-.]{32,4096}$/;

export function normalisePhone(address: string): string {
  return address.replace(/[\s\-()]/g, '');
}

export function isValidAddress(channel: NotificationChannel, address: string): boolean {
  switch (channel) {
    case 'EMAIL':
      return address.length <= 320 && EMAIL.test(address);
    case 'SMS':
      return E164.test(normalisePhone(address));
    case 'PUSH':
      return DEVICE_TOKEN.test(address);
    default:
      return false;
  }
}

/** For logs: enough to tell two recipients apart, not enough to contact them. */
export function redactAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at > 0) return `***@${address.slice(at + 1)}`;
  return `***${address.slice(-3)}`;
}
