import { z } from 'zod';
import type { NotificationEventType } from '../notification-event.service';
import { BODY_MAX_LENGTH, DELIVERY_CHANNELS, NOTIFICATION_TYPES } from '../notification-templates';

const channel = z.enum(DELIVERY_CHANNELS);
const eventType = z.enum(
  Object.keys(NOTIFICATION_TYPES) as [NotificationEventType, ...NotificationEventType[]],
);
const nonEmpty = (v: object) => Object.keys(v).length > 0;
const unique = <T>(values: T[]) => new Set(values).size === values.length;

export const notificationQuerySchema = z
  .object({
    status: z
      .enum([
        'PENDING',
        'SCHEDULED',
        'SENDING',
        'SENT',
        'DELIVERED',
        'FAILED',
        'RETRYING',
        'CANCELLED',
      ])
      .optional(),
    channel: z.enum(['EMAIL', 'SMS', 'PUSH', 'IN_APP']).optional(),
    type: z.string().trim().max(64).optional(),
    appointmentId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type NotificationQueryDto = z.infer<typeof notificationQuerySchema>;

/**
 * Company notification settings. Every part optional; what is sent replaces
 * that part only. `eventChannels` replaces the listed types and leaves the
 * others as they were.
 */
export const updateNotificationSettingsSchema = z
  .object({
    channels: z
      .object({ email: z.boolean(), sms: z.boolean(), push: z.boolean() })
      .partial()
      .strict()
      .optional(),
    reminders: z
      .object({
        enabled: z.boolean().optional(),
        /**
         * Minutes before the start. 15 minutes to 7 days, at most four, no
         * repeats — e.g. `[1440, 120]` for 24 hours and 2 hours before.
         */
        offsetsMinutes: z
          .array(z.number().int().min(15).max(10_080))
          .max(4)
          .refine(unique, 'Each reminder time may appear once.')
          .optional(),
      })
      .strict()
      .optional(),
    /** `{ "appointment.created": ["EMAIL", "SMS"] }`. An empty list switches that type off. */
    eventChannels: z
      .record(eventType, z.array(channel).max(3).refine(unique, 'Each channel may appear once.'))
      .optional(),
  })
  .strict()
  .refine(nonEmpty, 'Nothing to update.');
export type UpdateNotificationSettingsDto = z.infer<typeof updateNotificationSettingsSchema>;

export const templateQuerySchema = z
  .object({
    type: eventType.optional(),
    channel: channel.optional(),
    isActive: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type TemplateQueryDto = z.infer<typeof templateQuerySchema>;

const subject = z.string().trim().max(256);
const body = z.string().trim().min(1, 'Write a message.').max(BODY_MAX_LENGTH);

/**
 * A company's own wording for one (type, channel). Variables, the subject rule
 * per channel and the SMS length are checked by the service, which names the
 * offending field.
 */
export const createTemplateSchema = z
  .object({
    type: eventType,
    channel,
    /** Email subject, or push title. Ignored for SMS. */
    subject: subject.nullable().optional(),
    body,
    isActive: z.boolean().optional(),
  })
  .strict();
export type CreateTemplateDto = z.infer<typeof createTemplateSchema>;

/** Type and channel are fixed once created — make another template instead. */
export const updateTemplateSchema = z
  .object({
    subject: subject.nullable().optional(),
    body: body.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(nonEmpty, 'Nothing to update.');
export type UpdateTemplateDto = z.infer<typeof updateTemplateSchema>;

export const previewTemplateSchema = z
  .object({
    type: eventType,
    channel,
    subject: subject.nullable().optional(),
    body,
  })
  .strict();
export type PreviewTemplateDto = z.infer<typeof previewTemplateSchema>;

/** A customer's channel choices. Omitted channels are left as they are. */
export const customerPreferencesSchema = z
  .object({ email: z.boolean(), sms: z.boolean(), push: z.boolean() })
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to update.');
export type CustomerPreferencesDto = z.infer<typeof customerPreferencesSchema>;
