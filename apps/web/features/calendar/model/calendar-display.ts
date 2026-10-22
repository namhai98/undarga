import { ApiError } from '@/services/api-error';
import type { CalendarConnectionStatus, CalendarProvider } from '@/services/calendar.service';

export const PROVIDER_LABEL: Record<CalendarProvider, string> = {
  google: 'Google Calendar',
  microsoft: 'Microsoft Outlook',
};

export const STATUS_LABEL: Record<CalendarConnectionStatus, string> = {
  ACTIVE: 'Connected',
  NEEDS_REAUTH: 'Needs reconnecting',
  ERROR: 'Error',
};

/**
 * Send the browser to the provider's consent page. Its own module so tests
 * can replace it; only an https URL from our own API is followed.
 */
export function sendBrowserTo(url: string): void {
  if (!url.startsWith('https://')) throw new Error('Refusing a non-https authorisation URL.');
  window.location.assign(url);
}

export function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'never';
}

/** The server's own words where they are meant for people. */
export function calendarErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  switch (error.code) {
    case 'CALENDAR_OAUTH_INVALID':
    case 'CALENDAR_PROVIDER_UNAVAILABLE':
    case 'CALENDAR_PROVIDER_ERROR':
    case 'CONFLICT':
    case 'RESOURCE_NOT_FOUND':
      return error.message;
    case 'PERMISSION_DENIED':
      return 'You do not have permission to manage this calendar.';
    default:
      return fallback;
  }
}

/** What a provider's `error` query parameter means for a person. */
export function providerDenialMessage(error: string): string {
  return error === 'access_denied'
    ? 'Access was not granted, so the calendar was not connected.'
    : 'The calendar provider could not complete the connection. Try again.';
}
