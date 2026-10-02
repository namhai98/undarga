import { ApiError } from '@/services/api-error';
import type {
  NotificationChannel,
  NotificationRow,
  NotificationStatus,
} from '@/services/notifications.service';

export const CHANNEL_LABEL: Record<NotificationChannel | 'IN_APP', string> = {
  EMAIL: 'Email',
  SMS: 'SMS',
  PUSH: 'Push',
  IN_APP: 'In-app',
};

export const STATUS_LABEL: Record<NotificationStatus, string> = {
  PENDING: 'Queued',
  SCHEDULED: 'Scheduled',
  SENDING: 'Sending',
  SENT: 'Sent',
  DELIVERED: 'Delivered',
  FAILED: 'Failed',
  RETRYING: 'Retrying',
  CANCELLED: 'Not sent',
};

export function statusVariant(status: NotificationStatus): 'default' | 'secondary' | 'destructive' {
  if (status === 'SENT' || status === 'DELIVERED') return 'default';
  if (status === 'FAILED') return 'destructive';
  return 'secondary';
}

/** `appointment.created` → `Appointment created`, for a type the catalog does not name. */
export function humanType(type: string): string {
  const words = type.replace(/[._]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One line on where a message stands in its retry budget, or null when there
 * is nothing to say.
 */
export function retryState(row: NotificationRow): string | null {
  if (row.status === 'RETRYING') {
    const when = row.nextRetryAt ? new Date(row.nextRetryAt).toLocaleTimeString() : 'soon';
    return `Attempt ${row.retryCount} failed — retry ${row.retryCount} of ${row.maxRetries} at ${when}`;
  }
  if (row.status === 'FAILED') {
    return row.retryCount > 1 ? `Gave up after ${row.retryCount} attempts` : 'Not retried';
  }
  if (row.status === 'SENT' && row.retryCount > 0) {
    return `Sent after ${row.retryCount} failed attempt${row.retryCount === 1 ? '' : 's'}`;
  }
  return null;
}

/** 1440 → `24 hours before`, 30 → `30 minutes before`, 2880 → `2 days before`. */
export function offsetLabel(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? '24 hours before' : `${days} days before`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'} before`;
  }
  return `${minutes} minutes before`;
}

/** The choices on the settings screen. Anything else already saved is shown too. */
export const REMINDER_PRESETS = [10080, 2880, 1440, 720, 180, 120, 60, 30];

/** The server's own words where they are meant for people; the first field error otherwise. */
export function notificationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  switch (error.code) {
    case 'VALIDATION_FAILED': {
      const issues = error.details?.['issues'];
      if (Array.isArray(issues)) {
        const first = issues[0] as { message?: unknown } | undefined;
        return typeof first?.message === 'string' ? first.message : fallback;
      }
      if (issues && typeof issues === 'object') {
        const first = Object.values(issues)[0];
        return typeof first === 'string' ? first : fallback;
      }
      return fallback;
    }
    case 'CONFLICT':
    case 'RESOURCE_NOT_FOUND':
      return error.message;
    case 'PERMISSION_DENIED':
      return 'You do not have permission to do that.';
    default:
      return fallback;
  }
}
