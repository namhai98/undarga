import { z } from 'zod';

const e164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Use international format, e.g. +97699112233.');

/**
 * A company's own SendGrid account. `secrets.apiKey` is write-only: it is
 * encrypted on save and never returned. Omit `secrets` on an update to keep
 * the stored key.
 */
const sendgrid = z
  .object({
    provider: z.literal('sendgrid'),
    isEnabled: z.boolean().default(true),
    secrets: z
      .object({ apiKey: z.string().trim().min(20).max(256) })
      .strict()
      .optional(),
    settings: z
      .object({
        fromAddress: z.string().trim().email().max(254),
        fromName: z.string().trim().max(100).optional(),
        /** The Event Webhook's verification key, as SendGrid shows it. Public, not a secret. */
        webhookPublicKey: z.string().trim().max(600).optional(),
      })
      .strict(),
  })
  .strict();

/** A company's own Twilio account. `secrets.authToken` is write-only. */
const twilio = z
  .object({
    provider: z.literal('twilio'),
    isEnabled: z.boolean().default(true),
    secrets: z
      .object({ authToken: z.string().trim().min(16).max(128) })
      .strict()
      .optional(),
    settings: z
      .object({
        accountSid: z
          .string()
          .trim()
          .regex(/^AC[0-9a-fA-F]{32}$/, 'A Twilio Account SID starts with AC.'),
        fromNumber: e164.optional(),
        messagingServiceSid: z
          .string()
          .trim()
          .regex(/^MG[0-9a-fA-F]{32}$/, 'A Messaging Service SID starts with MG.')
          .optional(),
      })
      .strict()
      .refine((s) => !!s.fromNumber || !!s.messagingServiceSid, {
        message: 'Give a sending number or a Messaging Service SID.',
        path: ['fromNumber'],
      }),
  })
  .strict();

export const providerChannelSchema = z.enum(['EMAIL', 'SMS']);
export type ProviderChannel = z.infer<typeof providerChannelSchema>;

export const saveProviderConfigSchema = z.discriminatedUnion('provider', [sendgrid, twilio]);
export type SaveProviderConfigDto = z.infer<typeof saveProviderConfigSchema>;
