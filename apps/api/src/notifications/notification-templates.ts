import type { NotificationChannel } from '@prisma/client';
import { NOTIFICATION_EVENTS, type NotificationEventType } from './notification-event.service';

/**
 * ===========================================================================
 * TEMPLATES: PLATFORM DEFAULTS, TENANT OVERRIDES
 * ===========================================================================
 *
 * Every (type, channel) pair has a built-in default below. A company may write
 * its own in `notification_template`; the dispatcher uses an ACTIVE company row
 * when there is one and the default otherwise. So a company that never touches
 * templates still sends sensible messages, and switching a template to
 * inactive means "go back to the default", not "send nothing" — stopping a
 * message is a notification SETTING (which channels a type goes out on).
 *
 * The language is deliberately tiny: `{{variable}}`, nothing else. No loops,
 * no conditionals, no HTML — which also means a template cannot inject markup
 * or script into an email, because nothing here is ever interpreted as markup.
 * A variable that has no value renders as its fallback (e.g. "our team" for an
 * unassigned employee), never as a literal `{{…}}`.
 */

/** The only channels a notification is created on. IN_APP has no inbox yet. */
export const DELIVERY_CHANNELS = [
  'EMAIL',
  'SMS',
  'PUSH',
] as const satisfies readonly NotificationChannel[];
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export const TEMPLATE_VARIABLES = [
  'customerName',
  'serviceName',
  'branchName',
  'employeeName',
  'appointmentDate',
  'appointmentTime',
  'companyName',
  'giftCardBalance',
  'paymentAmount',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export type TemplateVariables = Partial<Record<TemplateVariable, string>>;

const APPOINTMENT_VARIABLES: TemplateVariable[] = [
  'customerName',
  'serviceName',
  'branchName',
  'employeeName',
  'appointmentDate',
  'appointmentTime',
  'companyName',
];

/** SMS longer than this is refused at save time: ~3 segments is already a lot. */
export const SMS_MAX_LENGTH = 480;
export const BODY_MAX_LENGTH = 4000;

interface TypeDefinition {
  readonly label: string;
  /** Which `{{variables}}` make sense for this type. Others are refused at save. */
  readonly variables: readonly TemplateVariable[];
  /** The channels this type goes out on unless the company says otherwise. */
  readonly defaultChannels: readonly DeliveryChannel[];
  readonly defaults: Readonly<Record<DeliveryChannel, { subject?: string; body: string }>>;
}

/**
 * Every notification type there is, with its platform default copy.
 *
 * Gift-card templates never offer the code: a message sits unencrypted in a
 * mailbox, on a lock screen and in a carrier's logs, and the code is bearer
 * value.
 */
export const NOTIFICATION_TYPES: Readonly<Record<NotificationEventType, TypeDefinition>> = {
  [NOTIFICATION_EVENTS.APPOINTMENT_CREATED]: {
    label: 'Appointment booked',
    variables: APPOINTMENT_VARIABLES,
    defaultChannels: ['EMAIL', 'SMS', 'PUSH'],
    defaults: {
      EMAIL: {
        subject: 'Your booking at {{companyName}}',
        body:
          'Hi {{customerName}},\n\nThank you for booking {{serviceName}} with {{employeeName}} at ' +
          '{{branchName}} on {{appointmentDate}} at {{appointmentTime}}.\n\n{{companyName}}',
      },
      SMS: {
        body: '{{companyName}}: {{serviceName}} booked for {{appointmentDate}} at {{appointmentTime}}.',
      },
      PUSH: {
        subject: 'Booking received',
        body: '{{serviceName}} on {{appointmentDate}} at {{appointmentTime}}',
      },
    },
  },
  [NOTIFICATION_EVENTS.APPOINTMENT_CONFIRMED]: {
    label: 'Appointment confirmed',
    variables: APPOINTMENT_VARIABLES,
    defaultChannels: ['EMAIL', 'SMS', 'PUSH'],
    defaults: {
      EMAIL: {
        subject: 'Your appointment is confirmed',
        body:
          'Hi {{customerName}},\n\nYour appointment for {{serviceName}} on {{appointmentDate}} at ' +
          '{{appointmentTime}} at {{branchName}} is confirmed.\n\n{{companyName}}',
      },
      SMS: {
        body: '{{companyName}}: confirmed — {{serviceName}}, {{appointmentDate}} at {{appointmentTime}}.',
      },
      PUSH: {
        subject: 'Appointment confirmed',
        body: '{{serviceName}} on {{appointmentDate}} at {{appointmentTime}}',
      },
    },
  },
  [NOTIFICATION_EVENTS.APPOINTMENT_RESCHEDULED]: {
    label: 'Appointment rescheduled',
    variables: APPOINTMENT_VARIABLES,
    defaultChannels: ['EMAIL', 'SMS', 'PUSH'],
    defaults: {
      EMAIL: {
        subject: 'Your appointment has moved',
        body:
          'Hi {{customerName}},\n\nYour appointment for {{serviceName}} has been moved to ' +
          '{{appointmentDate}} at {{appointmentTime}} at {{branchName}}.\n\n{{companyName}}',
      },
      SMS: {
        body: '{{companyName}}: your appointment has moved to {{appointmentDate}} at {{appointmentTime}}.',
      },
      PUSH: {
        subject: 'Appointment moved',
        body: 'Now {{appointmentDate}} at {{appointmentTime}}',
      },
    },
  },
  [NOTIFICATION_EVENTS.APPOINTMENT_CANCELLED]: {
    label: 'Appointment cancelled',
    variables: APPOINTMENT_VARIABLES,
    defaultChannels: ['EMAIL', 'SMS', 'PUSH'],
    defaults: {
      EMAIL: {
        subject: 'Your appointment has been cancelled',
        body:
          'Hi {{customerName}},\n\nYour appointment for {{serviceName}} on {{appointmentDate}} at ' +
          '{{appointmentTime}} has been cancelled.\n\n{{companyName}}',
      },
      SMS: {
        body: '{{companyName}}: your appointment on {{appointmentDate}} at {{appointmentTime}} is cancelled.',
      },
      PUSH: {
        subject: 'Appointment cancelled',
        body: '{{serviceName}} on {{appointmentDate}}',
      },
    },
  },
  [NOTIFICATION_EVENTS.APPOINTMENT_REMINDER]: {
    label: 'Appointment reminder',
    variables: APPOINTMENT_VARIABLES,
    defaultChannels: ['EMAIL', 'SMS', 'PUSH'],
    defaults: {
      EMAIL: {
        subject: 'Reminder: {{serviceName}} on {{appointmentDate}}',
        body:
          'Hi {{customerName}},\n\nA reminder of your appointment for {{serviceName}} with ' +
          '{{employeeName}} on {{appointmentDate}} at {{appointmentTime}} at {{branchName}}.' +
          '\n\n{{companyName}}',
      },
      SMS: {
        body: 'Reminder from {{companyName}}: {{serviceName}} on {{appointmentDate}} at {{appointmentTime}}.',
      },
      PUSH: {
        subject: 'Appointment reminder',
        body: '{{serviceName}} on {{appointmentDate}} at {{appointmentTime}}',
      },
    },
  },
  [NOTIFICATION_EVENTS.APPOINTMENT_COMPLETED]: {
    label: 'Appointment completed',
    variables: APPOINTMENT_VARIABLES,
    defaultChannels: ['EMAIL'],
    defaults: {
      EMAIL: {
        subject: 'Thank you for visiting {{companyName}}',
        body:
          'Hi {{customerName}},\n\nThank you for coming in for {{serviceName}} today. We hope to ' +
          'see you again soon.\n\n{{companyName}}',
      },
      SMS: { body: 'Thank you for visiting {{companyName}} today.' },
      PUSH: { subject: 'Thank you', body: 'Thanks for visiting {{companyName}}' },
    },
  },
  [NOTIFICATION_EVENTS.GIFT_CARD_ISSUED]: {
    label: 'Gift card issued',
    variables: ['customerName', 'companyName', 'giftCardBalance'],
    defaultChannels: ['EMAIL'],
    defaults: {
      EMAIL: {
        subject: 'You have a gift card from {{companyName}}',
        body:
          'Hi {{customerName}},\n\nA gift card worth {{giftCardBalance}} is waiting for you at ' +
          '{{companyName}}. Bring the card or its code with you when you visit.\n\n{{companyName}}',
      },
      SMS: { body: 'A gift card worth {{giftCardBalance}} is waiting for you at {{companyName}}.' },
      PUSH: {
        subject: 'Gift card',
        body: 'A gift card worth {{giftCardBalance}} is waiting for you',
      },
    },
  },
  [NOTIFICATION_EVENTS.GIFT_CARD_ASSIGNED]: {
    label: 'Gift card assigned',
    variables: ['customerName', 'companyName', 'giftCardBalance'],
    defaultChannels: ['EMAIL'],
    defaults: {
      EMAIL: {
        subject: 'A gift card has been added to your account',
        body:
          'Hi {{customerName}},\n\nA gift card with {{giftCardBalance}} on it has been added to ' +
          'your account at {{companyName}}.\n\n{{companyName}}',
      },
      SMS: {
        body: '{{companyName}}: a gift card with {{giftCardBalance}} is now on your account.',
      },
      PUSH: { subject: 'Gift card added', body: '{{giftCardBalance}} is now on your account' },
    },
  },
  [NOTIFICATION_EVENTS.PAYMENT_COMPLETED]: {
    label: 'Payment received',
    variables: ['customerName', 'companyName', 'paymentAmount'],
    defaultChannels: ['EMAIL'],
    defaults: {
      EMAIL: {
        subject: 'Payment received',
        body:
          'Hi {{customerName}},\n\nThank you — we have received your payment of {{paymentAmount}}.' +
          '\n\n{{companyName}}',
      },
      SMS: { body: '{{companyName}}: payment of {{paymentAmount}} received. Thank you.' },
      PUSH: { subject: 'Payment received', body: '{{paymentAmount}} — thank you' },
    },
  },
};

/** Every type with its label, variables, default channels and default wording. */
export function notificationCatalog() {
  return (Object.keys(NOTIFICATION_TYPES) as NotificationEventType[]).map((type) => ({
    type,
    label: NOTIFICATION_TYPES[type].label,
    variables: NOTIFICATION_TYPES[type].variables,
    defaultChannels: NOTIFICATION_TYPES[type].defaultChannels,
    defaults: NOTIFICATION_TYPES[type].defaults,
  }));
}

export function isNotificationType(type: string): type is NotificationEventType {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_TYPES, type);
}

/** What a variable reads as when there is no value — never a raw `{{…}}`. */
const FALLBACKS: Readonly<Record<TemplateVariable, string>> = {
  customerName: 'there',
  serviceName: 'your appointment',
  branchName: 'our location',
  employeeName: 'our team',
  appointmentDate: '',
  appointmentTime: '',
  companyName: 'us',
  giftCardBalance: 'a balance',
  paymentAmount: 'your payment',
};

/** Plausible values for the template preview. Clearly fictional. */
export const SAMPLE_VARIABLES: Readonly<Record<TemplateVariable, string>> = {
  customerName: 'Sara',
  serviceName: 'Haircut',
  branchName: 'Downtown',
  employeeName: 'Ari',
  appointmentDate: 'Tue, 6 Oct 2026',
  appointmentTime: '10:00',
  companyName: 'Lotus Spa',
  giftCardBalance: '₮100,000.00',
  paymentAmount: '₮45,000.00',
};

const VARIABLE = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

export interface RenderedMessage {
  readonly subject: string | null;
  readonly body: string;
}

/**
 * Substitute `{{variables}}`. Unknown names render empty (they cannot be saved,
 * so this only happens with data written before a rename).
 */
export function renderTemplate(
  template: { subject?: string | null; body: string },
  variables: TemplateVariables,
): RenderedMessage {
  const fill = (text: string) =>
    text.replace(VARIABLE, (_, name: string) => {
      if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) return '';
      const key = name as TemplateVariable;
      const value = variables[key];
      return value !== undefined && value !== '' ? value : FALLBACKS[key];
    });

  return {
    subject: template.subject ? fill(template.subject).trim().slice(0, 256) : null,
    body: fill(template.body).trim(),
  };
}

/** Every `{{name}}` in a text, in order, without duplicates. */
export function variablesIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(VARIABLE)) found.add(match[1]!);
  return [...found];
}

/** The platform default for a (type, channel). */
export function defaultTemplate(type: NotificationEventType, channel: DeliveryChannel) {
  return NOTIFICATION_TYPES[type].defaults[channel];
}

/**
 * Which channels each type goes out on, for a company: its own choice where it
 * made one, the platform default otherwise. Anything malformed in the stored
 * JSON is ignored rather than trusted.
 */
export function effectiveEventChannels(
  stored: unknown,
): Record<NotificationEventType, DeliveryChannel[]> {
  const chosen =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const result = {} as Record<NotificationEventType, DeliveryChannel[]>;
  for (const type of Object.keys(NOTIFICATION_TYPES) as NotificationEventType[]) {
    const value = chosen[type];
    result[type] = Array.isArray(value)
      ? DELIVERY_CHANNELS.filter((channel) => value.includes(channel))
      : [...NOTIFICATION_TYPES[type].defaultChannels];
  }
  return result;
}
