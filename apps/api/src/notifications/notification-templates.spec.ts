import type { AppConfig } from '../config';
import {
  NOTIFICATION_TYPES,
  SAMPLE_VARIABLES,
  defaultTemplate,
  effectiveEventChannels,
  consentAllows,
  renderTemplate,
  variablesIn,
} from './notification-templates';
import {
  EmailNotificationProvider,
  PushNotificationProvider,
  SmsNotificationProvider,
} from './providers/channel.providers';

describe('notification templates', () => {
  it('fills every supported variable', () => {
    const rendered = renderTemplate(
      {
        subject: '{{companyName}}: {{serviceName}}',
        body:
          '{{customerName}} {{serviceName}} {{branchName}} {{employeeName}} ' +
          '{{appointmentDate}} {{appointmentTime}} {{companyName}}',
      },
      {
        customerName: 'Sara',
        serviceName: 'Haircut',
        branchName: 'Downtown',
        employeeName: 'Ari',
        appointmentDate: 'Tue, Oct 6, 2026',
        appointmentTime: '10:00',
        companyName: 'Lotus',
      },
    );
    expect(rendered).toEqual({
      subject: 'Lotus: Haircut',
      body: 'Sara Haircut Downtown Ari Tue, Oct 6, 2026 10:00 Lotus',
    });
  });

  it('tolerates spacing inside the braces', () => {
    expect(renderTemplate({ body: 'Hi {{ customerName }}' }, { customerName: 'Sara' }).body).toBe(
      'Hi Sara',
    );
  });

  it('uses a readable fallback for a missing value, never the raw placeholder', () => {
    const { body } = renderTemplate(
      { body: 'Hi {{customerName}}, with {{employeeName}}' },
      { customerName: '' },
    );
    expect(body).toBe('Hi there, with our team');
    expect(body).not.toContain('{{');
  });

  it('renders an unknown variable as nothing', () => {
    expect(renderTemplate({ body: 'A{{secret}}B' }, {}).body).toBe('AB');
  });

  it('does not interpret anything but variables — markup stays text', () => {
    const { body } = renderTemplate(
      { body: '<b>{{customerName}}</b>' },
      { customerName: '<script>' },
    );
    expect(body).toBe('<b><script></b>');
  });

  it('lists the variables a text uses, once each', () => {
    expect(variablesIn('{{a}} {{ b }} {{a}}')).toEqual(['a', 'b']);
  });

  it('has a default for every type on every channel, using only that type’s variables', () => {
    for (const [type, definition] of Object.entries(NOTIFICATION_TYPES)) {
      for (const channel of ['EMAIL', 'SMS', 'PUSH'] as const) {
        const template = defaultTemplate(type as keyof typeof NOTIFICATION_TYPES, channel);
        const used = variablesIn(`${template.subject ?? ''} ${template.body}`);
        for (const name of used) expect(definition.variables).toContain(name);
        if (channel !== 'SMS') expect(template.subject).toBeTruthy();
      }
    }
  });

  it('never offers a gift-card code in any default', () => {
    for (const type of ['gift_card.issued', 'gift_card.assigned'] as const) {
      for (const channel of ['EMAIL', 'SMS', 'PUSH'] as const) {
        const template = defaultTemplate(type, channel);
        expect(`${template.subject ?? ''}${template.body}`.toLowerCase()).not.toMatch(
          /\{\{\s*\w*code/,
        );
      }
    }
  });

  it('renders every default with sample values and no leftover braces', () => {
    for (const type of Object.keys(NOTIFICATION_TYPES) as Array<keyof typeof NOTIFICATION_TYPES>) {
      for (const channel of ['EMAIL', 'SMS', 'PUSH'] as const) {
        const { subject, body } = renderTemplate(defaultTemplate(type, channel), SAMPLE_VARIABLES);
        expect(`${subject ?? ''}${body}`).not.toContain('{{');
      }
    }
  });

  it('uses the company’s channel choices where it made them and defaults elsewhere', () => {
    const channels = effectiveEventChannels({
      'appointment.created': ['SMS'],
      'appointment.reminder': [],
      'payment.completed': ['FAX', 'EMAIL'],
    });
    expect(channels['appointment.created']).toEqual(['SMS']);
    expect(channels['appointment.reminder']).toEqual([]);
    // Anything unknown in stored JSON is ignored, not trusted.
    expect(channels['payment.completed']).toEqual(['EMAIL']);
    expect(channels['appointment.cancelled']).toEqual(['EMAIL', 'SMS', 'PUSH']);
    expect(effectiveEventChannels('garbage')['gift_card.issued']).toEqual(['EMAIL']);
  });
});

describe('channel providers', () => {
  const config = { app: { isProduction: false, isDevelopment: false, isTest: true } } as AppConfig;

  it('validates addresses per channel', () => {
    const email = new EmailNotificationProvider(config);
    const sms = new SmsNotificationProvider(config);
    const push = new PushNotificationProvider(config);

    expect(email.isValidAddress('sara@example.com')).toBe(true);
    expect(email.isValidAddress('not-an-email')).toBe(false);
    expect(email.isValidAddress('a b@example.com')).toBe(false);

    expect(sms.isValidAddress('+97699112233')).toBe(true);
    expect(sms.isValidAddress('+976 9911-2233')).toBe(true);
    expect(sms.isValidAddress('99112233')).toBe(false);
    expect(sms.isValidAddress('call me')).toBe(false);

    expect(push.isValidAddress('x'.repeat(64))).toBe(true);
    expect(push.isValidAddress('short')).toBe(false);
  });

  it('delivers, records, and fails on request', async () => {
    const email = new EmailNotificationProvider(config);
    const message = { channel: 'EMAIL' as const, to: 'a@b.co', body: 'Hi', notificationId: 'n1' };

    await expect(email.send(message)).resolves.toMatchObject({
      status: 'SENT',
      provider: 'mock-email',
    });
    expect(email.delivered).toHaveLength(1);

    email.failNext(1, { retryable: false, reason: 'Mailbox does not exist' });
    await expect(email.send(message)).resolves.toMatchObject({
      status: 'FAILED',
      retryable: false,
      failureReason: 'Mailbox does not exist',
    });

    email.failNext(1, { throws: true });
    await expect(email.send(message)).rejects.toThrow(/Simulated EMAIL failure/);
    await expect(email.send(message)).resolves.toMatchObject({ status: 'SENT' });
  });

  it('refuses to simulate failures in production', async () => {
    const prod = new SmsNotificationProvider({
      app: { isProduction: true, isDevelopment: false, isTest: false },
    } as AppConfig);
    prod.failNext(1);
    const result = await prod.send({
      channel: 'SMS',
      to: '+97699112233',
      body: 'x',
      notificationId: 'n',
    });
    expect(result.status).toBe('SENT');
    expect(prod.delivered).toHaveLength(0);
  });
});

describe('consent and categories', () => {
  const granted = (type: string) => ({ type, revokedAt: null });
  const revoked = (type: string) => ({ type, revokedAt: new Date() });

  it('sends transactional and billing messages regardless of marketing consent', () => {
    expect(consentAllows('TRANSACTIONAL', 'EMAIL', [])).toBe(true);
    expect(consentAllows('BILLING', 'SMS', [revoked('MARKETING_SMS')])).toBe(true);
  });

  it('sends reminders by default and honours an explicit revocation', () => {
    expect(consentAllows('REMINDER', 'SMS', [])).toBe(true);
    expect(consentAllows('REMINDER', 'SMS', [granted('APPOINTMENT_REMINDERS')])).toBe(true);
    // Newest first: the latest answer wins.
    expect(
      consentAllows('REMINDER', 'SMS', [
        revoked('APPOINTMENT_REMINDERS'),
        granted('APPOINTMENT_REMINDERS'),
      ]),
    ).toBe(false);
    expect(
      consentAllows('REMINDER', 'SMS', [
        granted('APPOINTMENT_REMINDERS'),
        revoked('APPOINTMENT_REMINDERS'),
      ]),
    ).toBe(true);
  });

  it('never sends marketing without a live consent for that channel, and never on push', () => {
    expect(consentAllows('MARKETING', 'EMAIL', [])).toBe(false);
    expect(consentAllows('MARKETING', 'EMAIL', [granted('MARKETING_SMS')])).toBe(false);
    expect(consentAllows('MARKETING', 'EMAIL', [granted('MARKETING_EMAIL')])).toBe(true);
    expect(consentAllows('MARKETING', 'EMAIL', [revoked('MARKETING_EMAIL')])).toBe(false);
    expect(
      consentAllows('MARKETING', 'PUSH', [granted('MARKETING_EMAIL'), granted('MARKETING_SMS')]),
    ).toBe(false);
  });

  it('marks reminders as REMINDER and billing types as owner-addressed', () => {
    expect(NOTIFICATION_TYPES['appointment.reminder'].category).toBe('REMINDER');
    expect(NOTIFICATION_TYPES['subscription.invoice_issued']).toMatchObject({
      category: 'BILLING',
      audience: 'COMPANY_OWNER',
    });
    expect(NOTIFICATION_TYPES['subscription.payment_failed']).toMatchObject({
      category: 'BILLING',
      audience: 'COMPANY_OWNER',
    });
    expect(NOTIFICATION_TYPES['payment.failed']).toMatchObject({
      category: 'TRANSACTIONAL',
      audience: 'CUSTOMER',
    });
  });

  it('renders the new payment, invoice and gift card variables', () => {
    const invoice = renderTemplate(
      defaultTemplate('subscription.invoice_issued', 'EMAIL'),
      SAMPLE_VARIABLES,
    );
    expect(invoice.subject).toBe('Invoice INV-202610-0001 for Lotus Spa');
    expect(invoice.body).toContain('₮99,000.00');
    expect(invoice.body).toContain('Fri, 30 Oct 2026');

    const failed = renderTemplate(defaultTemplate('payment.failed', 'EMAIL'), SAMPLE_VARIABLES);
    expect(failed.body).toContain('declined by the bank');

    const gift = renderTemplate(defaultTemplate('gift_card.issued', 'EMAIL'), {
      ...SAMPLE_VARIABLES,
      giftCardExpiry: undefined,
    });
    expect(gift.body).toContain('ending 4821');
    expect(gift.body).toContain('valid with no expiry date');
    expect(gift.body).not.toContain('{{');
  });
});
