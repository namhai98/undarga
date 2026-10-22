import { generateKeyPairSync, sign } from 'node:crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import type { Server } from 'node:http';
import { PLATFORM_PERMISSIONS, SYSTEM_ROLES } from '../src/authz/permissions';
import { NotificationSchedulerService } from '../src/notifications/notification-scheduler.service';
import {
  EmailNotificationProvider,
  PushNotificationProvider,
  SmsNotificationProvider,
} from '../src/notifications/providers/channel.providers';
import { NOTIFICATION_PROVIDERS } from '../src/notifications/providers/notification-provider';
import { twilioSignature } from '../src/notifications/providers/twilio.provider';
import { syncPlanCatalog } from '../src/subscriptions/plan-catalog';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedPlatformUser, seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * REAL NOTIFICATION PROVIDERS
 * ===========================================================================
 *
 * What a provider answered, and nothing more, is what a notification says:
 * accepted is SENT, DELIVERED needs the provider's confirmation (a signed
 * receipt), and a provider that never answered is UNKNOWN — not retried by
 * itself, because it may already have sent the message.
 *
 * The platform providers are the in-memory mocks (EMAIL/SMS/PUSH_PROVIDER=mock
 * in test-env.ts). A company's own SendGrid / Twilio account is the real
 * adapter, with `fetch` mocked: nothing here reaches a network.
 */
describe('notification providers', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let ownerA: string;
  let ownerB: string;
  let scheduler: NotificationSchedulerService;
  let email: EmailNotificationProvider;
  let sms: SmsNotificationProvider;
  let push: PushNotificationProvider;
  let unique = 0;

  const BASE = 'https://api.undarga.test';
  const API_KEY = 'SG.company-a-test-key-not-real-0000';
  const AUTH_TOKEN = 'twilio-test-token-not-real-0000';
  const ACCOUNT_SID = `AC${'a'.repeat(32)}`;
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const webhookPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  const api = (path: string, companyId = world.companyA.id) =>
    `/api/v1/companies/${companyId}/${path}`;
  const as = (token: string) => ({
    get: (path: string) => request(http).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      request(http).post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) =>
      request(http).put(path).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) => request(http).delete(path).set('Authorization', `Bearer ${token}`),
  });

  /** An outbox event, as a business write would leave it. */
  async function emit(
    type: string,
    payload: Record<string, unknown>,
    companyId = world.companyA.id,
  ) {
    const dedupeBase = `prov-${Date.now()}-${unique++}`;
    await harness.prisma.outboxEvent.create({
      data: { companyId, type, payload: { ...payload, dedupeBase } },
    });
    return dedupeBase;
  }
  const paymentReceipt = (companyId = world.companyA.id, customerId = world.companyA.customerId) =>
    emit(
      'payment.completed',
      { customerId, amountMinor: '450000', currencyCode: 'MNT' },
      companyId,
    );
  const rowsFor = (dedupeBase: string) =>
    harness.prisma.notification.findMany({
      where: { dedupeKey: { startsWith: `${dedupeBase}:` } },
      orderBy: { channel: 'asc' },
    });
  const run = (companyId = world.companyA.id) => scheduler.runOnce({ companyId });

  async function member(roleKey: string): Promise<string> {
    const known = await harness.prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await harness.prisma.userAccount.create({
      data: {
        email: `prov-${roleKey.toLowerCase()}-${Date.now()}-${unique++}@example.com`,
        fullName: roleKey,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        passwordHash: known.passwordHash,
      },
    });
    const membership = await harness.prisma.companyUser.create({
      data: { companyId: world.companyA.id, userAccountId: account.id, status: 'ACTIVE' },
    });
    const role = await harness.prisma.companyRole.findFirstOrThrow({
      where: { companyId: world.companyA.id, key: roleKey },
    });
    await harness.prisma.companyUserRole.create({
      data: { companyId: world.companyA.id, companyUserId: membership.id, roleId: role.id },
    });
    return harness.staffTokenForCompany(account.email, world.companyA.id);
  }

  const sendgridConfig = (overrides: Record<string, unknown> = {}) => ({
    provider: 'sendgrid',
    secrets: { apiKey: API_KEY },
    settings: { fromAddress: 'bookings@company-a.test', fromName: 'Company A', webhookPublicKey },
    ...overrides,
  });
  const twilioConfig = (overrides: Record<string, unknown> = {}) => ({
    provider: 'twilio',
    secrets: { authToken: AUTH_TOKEN },
    settings: { accountSid: ACCOUNT_SID, fromNumber: '+15005550006' },
    ...overrides,
  });

  /** Replace the global fetch for one test. `respond` sees every provider call. */
  function mockFetch(respond: (url: string, init: RequestInit | undefined) => Response) {
    return jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(respond(String(input instanceof Request ? input.url : input), init)),
      );
  }

  function signedSendGrid(events: unknown[], configId: string) {
    const raw = JSON.stringify(events);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(
      'sha256',
      Buffer.concat([Buffer.from(timestamp), Buffer.from(raw)]),
      privateKey,
    ).toString('base64');
    return request(http)
      .post(`/api/v1/notifications/receipts/sendgrid/${configId}`)
      .set('Content-Type', 'application/json')
      .set('X-Twilio-Email-Event-Webhook-Signature', signature)
      .set('X-Twilio-Email-Event-Webhook-Timestamp', timestamp)
      .send(raw);
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);
    scheduler = harness.app.get(NotificationSchedulerService);
    email = harness.app.get(EmailNotificationProvider);
    sms = harness.app.get(SmsNotificationProvider);
    push = harness.app.get(PushNotificationProvider);
  });

  beforeEach(async () => {
    email.reset();
    sms.reset();
    push.reset();
    await harness.prisma.notificationProviderConfig.deleteMany({});
    await harness.prisma.companySettings.updateMany({
      data: {
        emailNotificationsEnabled: true,
        smsNotificationsEnabled: true,
        pushNotificationsEnabled: true,
        notificationEventChannels: Prisma.DbNull,
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('delivery outcomes', () => {
    it('records the provider accepting a message as SENT, not delivered', async () => {
      const base = await paymentReceipt();
      await run();
      const [row] = await rowsFor(base);
      expect(row).toMatchObject({
        channel: 'EMAIL',
        status: 'SENT',
        provider: 'mock-email',
        providerStatus: 'accepted',
      });
      expect(row!.sentAt).not.toBeNull();
      expect(row!.deliveredAt).toBeNull();
    });

    it('records DELIVERED only when the provider confirms it', async () => {
      email.answerNext('DELIVERED');
      const base = await paymentReceipt();
      await run();
      const [row] = await rowsFor(base);
      expect(row).toMatchObject({ status: 'DELIVERED', providerStatus: 'delivered' });
      expect(row!.deliveredAt).not.toBeNull();
    });

    it('never retries an UNKNOWN outcome by itself; a manual retry sends the same row again', async () => {
      email.answerNext('UNKNOWN');
      const base = await paymentReceipt();
      await run();
      let [row] = await rowsFor(base);
      expect(row).toMatchObject({ status: 'UNKNOWN', nextRetryAt: null });

      await run();
      await run();
      expect(email.delivered).toHaveLength(0);
      [row] = await rowsFor(base);
      expect(row!.status).toBe('UNKNOWN');

      const history = await as(ownerA)
        .get(api(`notifications/${row!.id}`))
        .expect(200);
      expect(history.body.data).toMatchObject({ status: 'UNKNOWN', retryable: true });

      const retried = await as(ownerA)
        .post(api(`notifications/${row!.id}/retry`))
        .expect(200);
      expect(retried.body.data.status).toBe('PENDING');
      await run();

      const after = await rowsFor(base);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: row!.id, status: 'SENT' });
      expect(email.delivered).toHaveLength(1);

      const audit = await harness.prisma.auditLog.findFirst({
        where: { action: 'notification.retried', resourceId: row!.id },
      });
      expect(audit).not.toBeNull();
    });

    it('lets a permanently failed message be retried by hand, and refuses anything else', async () => {
      email.failNext(1, { retryable: false, reason: 'Mailbox does not exist' });
      const base = await paymentReceipt();
      await run();
      const [failed] = await rowsFor(base);
      expect(failed).toMatchObject({ status: 'FAILED', failureReason: 'Mailbox does not exist' });

      await as(ownerA)
        .post(api(`notifications/${failed!.id}/retry`))
        .expect(200);
      await run();
      const [sent] = await rowsFor(base);
      expect(sent!.status).toBe('SENT');

      // Already sent: nothing to retry.
      const again = await as(ownerA)
        .post(api(`notifications/${sent!.id}/retry`))
        .expect(409);
      expect(again.body.error.code).toBe('CONFLICT');
      await as(ownerA)
        .post(api('notifications/018f0000-0000-7000-8000-00000000dead/retry'))
        .expect(404);
    });

    it('sends one message per event and channel, however often the event is replayed', async () => {
      const base = await paymentReceipt();
      await harness.prisma.outboxEvent.create({
        data: {
          companyId: world.companyA.id,
          type: 'payment.completed',
          payload: {
            customerId: world.companyA.customerId,
            amountMinor: '450000',
            currencyCode: 'MNT',
            dedupeBase: base,
          },
        },
      });
      await run();
      await run();
      expect(await rowsFor(base)).toHaveLength(1);
      expect(email.delivered).toHaveLength(1);
    });
  });

  // ===========================================================================
  describe('consent, preferences, recipients and language', () => {
    it('honours a revoked reminder consent, but still sends booking messages', async () => {
      const { companyA } = world;
      await harness.prisma.customerConsent.create({
        data: {
          companyId: companyA.id,
          customerId: companyA.customerId,
          type: 'APPOINTMENT_REMINDERS',
          grantedAt: new Date(Date.now() - 86_400_000),
          revokedAt: new Date(),
          source: 'test',
        },
      });
      try {
        const reminder = await emit('appointment.reminder', {
          appointmentId: companyA.appointmentId,
        });
        const booked = await emit('appointment.created', { appointmentId: companyA.appointmentId });
        await run();
        expect(await rowsFor(reminder)).toHaveLength(0);
        expect((await rowsFor(booked)).map((r) => r.channel)).toEqual(['EMAIL', 'SMS']);
      } finally {
        await harness.prisma.customerConsent.deleteMany({
          where: { customerId: companyA.customerId },
        });
      }
    });

    it('respects a customer switching a channel off', async () => {
      const { companyA } = world;
      await harness.prisma.notificationPreference.create({
        data: {
          companyId: companyA.id,
          subjectType: 'CUSTOMER',
          subjectId: companyA.customerId,
          channel: 'SMS',
          isEnabled: false,
        },
      });
      try {
        const booked = await emit('appointment.created', { appointmentId: companyA.appointmentId });
        await run();
        expect((await rowsFor(booked)).map((r) => r.channel)).toEqual(['EMAIL']);
      } finally {
        await harness.prisma.notificationPreference.deleteMany({
          where: { subjectId: companyA.customerId },
        });
      }
    });

    it('writes in the customer’s language when the company has a template for it', async () => {
      const companyId = world.companyA.id;
      const customer = await harness.prisma.companyCustomer.create({
        data: {
          companyId,
          firstName: 'Saraa',
          lastName: 'B',
          email: `saraa${unique++}@example.com`,
          locale: 'mn-MN',
        },
      });
      await harness.prisma.notificationTemplate.createMany({
        data: [
          {
            companyId,
            key: 'payment.completed',
            channel: 'EMAIL',
            locale: 'en-US',
            subject: 'Paid',
            body: 'Thanks {{customerName}}',
          },
          {
            companyId,
            key: 'payment.completed',
            channel: 'EMAIL',
            locale: 'mn-MN',
            subject: 'Төлбөр',
            body: 'Баярлалаа {{customerName}}',
          },
        ],
      });
      try {
        const base = await paymentReceipt(companyId, customer.id);
        await run();
        const [row] = await rowsFor(base);
        expect(row).toMatchObject({ locale: 'mn-MN', subject: 'Төлбөр', body: 'Баярлалаа Saraa' });
      } finally {
        await harness.prisma.notificationTemplate.deleteMany({
          where: { companyId, key: 'payment.completed' },
        });
      }
    });

    it('sends a subscription invoice to the company owner, not subject to customer channel switches', async () => {
      const companyId = world.companyB.id;
      await syncPlanCatalog(harness.prisma);
      const plan = await harness.prisma.plan.findUniqueOrThrow({ where: { key: 'STARTER' } });
      const now = new Date();
      const subscription = await harness.prisma.subscription.upsert({
        where: { companyId },
        create: {
          companyId,
          planId: plan.id,
          status: 'ACTIVE',
          currentPeriodStart: now,
          currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
        },
        update: {},
      });
      const invoice = await harness.prisma.subscriptionInvoice.create({
        data: {
          companyId,
          subscriptionId: subscription.id,
          planId: plan.id,
          planName: 'Starter',
          number: `INV-TEST-${unique++}`,
          status: 'OPEN',
          amountMinor: 9_900_000n,
          totalMinor: 9_900_000n,
          currencyCode: 'MNT',
          periodStart: now,
          periodEnd: new Date(now.getTime() + 30 * 86_400_000),
          issuedAt: now,
          dueAt: new Date(now.getTime() + 7 * 86_400_000),
        },
      });
      await harness.prisma.companyUser.updateMany({
        where: { companyId, userAccountId: world.userB.id },
        data: { isOwner: true },
      });
      // Customer emails off: an invoice is not a customer message.
      await harness.prisma.companySettings.updateMany({
        where: { companyId },
        data: { emailNotificationsEnabled: false },
      });
      try {
        const billing = await emit(
          'subscription.invoice_issued',
          { invoiceId: invoice.id },
          companyId,
        );
        const receipt = await paymentReceipt(companyId, world.companyB.customerId);
        await run(companyId);

        const [row] = await rowsFor(billing);
        expect(row).toMatchObject({
          channel: 'EMAIL',
          recipientType: 'COMPANY_USER',
          recipientAddress: world.userB.email,
          status: 'SENT',
        });
        expect(row!.subject).toContain(invoice.number);
        expect(row!.body).toContain('99,000.00');
        expect(await rowsFor(receipt)).toHaveLength(0);
      } finally {
        await harness.prisma.subscriptionInvoice.deleteMany({ where: { companyId } });
        await harness.prisma.subscription.deleteMany({ where: { companyId } });
        await harness.prisma.companyUser.updateMany({
          where: { companyId, userAccountId: world.userB.id },
          data: { isOwner: false },
        });
      }
    });
  });

  // ===========================================================================
  describe('company provider accounts', () => {
    it('saves a SendGrid account with the key encrypted, and never returns it', async () => {
      const saved = await as(ownerA)
        .put(api('notification-providers/EMAIL'), sendgridConfig())
        .expect(200);
      expect(saved.body.data).toMatchObject({
        channel: 'EMAIL',
        active: 'company',
        company: {
          provider: 'sendgrid',
          isEnabled: true,
          status: 'UNVERIFIED',
          secretHint: `••••${API_KEY.slice(-4)}`,
          settings: { fromAddress: 'bookings@company-a.test', fromName: 'Company A' },
        },
      });
      expect(saved.body.data.company.receiptUrl).toBe(
        `${BASE}/api/v1/notifications/receipts/sendgrid/${saved.body.data.company.id}`,
      );

      const listed = await as(ownerA).get(api('notification-providers')).expect(200);
      expect(listed.body.data.companyAccountsAvailable).toBe(true);
      expect(listed.body.data.channels.map((c: { channel: string }) => c.channel)).toEqual([
        'EMAIL',
        'SMS',
        'PUSH',
      ]);
      for (const body of [saved.text, listed.text]) expect(body).not.toContain(API_KEY);

      const stored = await harness.prisma.notificationProviderConfig.findFirstOrThrow({
        where: { companyId: world.companyA.id, channel: 'EMAIL' },
      });
      expect(stored.credentials).not.toContain(API_KEY);
      expect(stored.credentials.startsWith('v1.')).toBe(true);

      const audit = await harness.prisma.auditLog.findMany({
        where: { resourceType: 'NotificationProviderConfig', companyId: world.companyA.id },
      });
      expect(audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit)).not.toContain(API_KEY);
    });

    it('keeps the stored key on an edit without secrets, and needs one for a new account', async () => {
      await as(ownerA).put(api('notification-providers/EMAIL'), sendgridConfig()).expect(200);
      const before = await harness.prisma.notificationProviderConfig.findFirstOrThrow({
        where: { channel: 'EMAIL' },
      });
      await as(ownerA)
        .put(
          api('notification-providers/EMAIL'),
          sendgridConfig({ secrets: undefined, isEnabled: false }),
        )
        .expect(200);
      const after = await harness.prisma.notificationProviderConfig.findFirstOrThrow({
        where: { channel: 'EMAIL' },
      });
      expect(after.credentials).toBe(before.credentials);
      expect(after.isEnabled).toBe(false);

      await as(ownerA)
        .put(api('notification-providers/SMS'), twilioConfig({ secrets: undefined }))
        .expect(400);
    });

    it('refuses an invalid configuration', async () => {
      const bad = [
        ['EMAIL', sendgridConfig({ settings: { fromAddress: 'not-an-email' } })],
        ['EMAIL', sendgridConfig({ secrets: { apiKey: 'short' } })],
        [
          'EMAIL',
          sendgridConfig({ settings: { fromAddress: 'a@b.test', webhookPublicKey: 'not-a-key' } }),
        ],
        ['EMAIL', sendgridConfig({ extra: true })],
        ['SMS', sendgridConfig()],
        ['EMAIL', twilioConfig()],
        ['SMS', twilioConfig({ settings: { accountSid: ACCOUNT_SID } })],
        [
          'SMS',
          twilioConfig({ settings: { accountSid: 'not-a-sid', fromNumber: '+15005550006' } }),
        ],
        ['PUSH', sendgridConfig()],
      ] as const;
      for (const [channel, body] of bad) {
        const res = await as(ownerA).put(api(`notification-providers/${channel}`), body);
        expect([channel, res.status]).toEqual([channel, 400]);
      }
      expect(await harness.prisma.notificationProviderConfig.count()).toBe(0);
    });

    it('verifies the credentials with the provider and records the answer', async () => {
      await as(ownerA).put(api('notification-providers/EMAIL'), sendgridConfig()).expect(200);

      const calls = mockFetch((url) =>
        url.endsWith('/v3/scopes')
          ? new Response(JSON.stringify({ scopes: ['mail.send'] }), { status: 200 })
          : new Response('', { status: 404 }),
      );
      const ok = await as(ownerA).post(api('notification-providers/EMAIL/verify')).expect(200);
      expect(ok.body.data.company).toMatchObject({ status: 'CONNECTED', lastError: null });
      expect((calls.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${API_KEY}`,
      );

      calls.mockImplementation(() => Promise.resolve(new Response('', { status: 401 })));
      const failed = await as(ownerA).post(api('notification-providers/EMAIL/verify')).expect(200);
      expect(failed.body.data.company).toMatchObject({ status: 'FAILED' });
      expect(failed.body.data.company.lastError).toContain('401');
      expect(failed.text).not.toContain(API_KEY);
    });

    it('sends through the company’s own account when it is enabled, and the platform’s when not', async () => {
      const saved = await as(ownerA)
        .put(api('notification-providers/EMAIL'), sendgridConfig())
        .expect(200);
      const configId = saved.body.data.company.id as string;
      const calls = mockFetch(
        () => new Response(null, { status: 202, headers: { 'x-message-id': 'sg-msg-1' } }),
      );

      const base = await paymentReceipt();
      await run();
      const [row] = await rowsFor(base);
      expect(row).toMatchObject({
        status: 'SENT',
        provider: 'sendgrid',
        providerConfigId: configId,
        providerMessageId: 'sg-msg-1',
        providerStatus: 'accepted',
      });
      expect(email.delivered).toHaveLength(0);
      const [url, init] = calls.mock.calls[0]!;
      expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
      const body = JSON.parse(init!.body as string);
      expect(body.from.email).toBe('bookings@company-a.test');
      expect(body.custom_args.notification_id).toBe(row!.id);

      await as(ownerA).put(
        api('notification-providers/EMAIL'),
        sendgridConfig({ secrets: undefined, isEnabled: false }),
      );
      const second = await paymentReceipt();
      await run();
      expect((await rowsFor(second))[0]).toMatchObject({
        provider: 'mock-email',
        providerConfigId: null,
      });
    });

    it('fails a message, and flags the account, when its stored key cannot be decrypted', async () => {
      await as(ownerA).put(api('notification-providers/EMAIL'), sendgridConfig()).expect(200);
      // Credentials sealed for another company: the context check refuses them.
      const sealedElsewhere = (
        await harness.prisma.notificationProviderConfig.findFirstOrThrow({
          where: { channel: 'EMAIL' },
        })
      ).credentials;
      await as(ownerB)
        .put(api('notification-providers/EMAIL', world.companyB.id), sendgridConfig())
        .expect(200);
      await harness.prisma.notificationProviderConfig.updateMany({
        where: { companyId: world.companyB.id, channel: 'EMAIL' },
        data: { credentials: sealedElsewhere },
      });
      const fetchSpy = mockFetch(() => new Response(null, { status: 202 }));

      const base = await paymentReceipt(world.companyB.id, world.companyB.customerId);
      await run(world.companyB.id);
      const [row] = await rowsFor(base);
      expect(row).toMatchObject({ status: 'FAILED' });
      expect(row!.failureReason).toContain('could not be read');
      expect(fetchSpy).not.toHaveBeenCalled();
      const config = await harness.prisma.notificationProviderConfig.findFirstOrThrow({
        where: { companyId: world.companyB.id, channel: 'EMAIL' },
      });
      expect(config.status).toBe('FAILED');
    });

    it('removes an account, falling back to the platform provider', async () => {
      await as(ownerA).put(api('notification-providers/EMAIL'), sendgridConfig()).expect(200);
      const removed = await as(ownerA).delete(api('notification-providers/EMAIL')).expect(200);
      expect(removed.body.data).toMatchObject({
        active: 'platform',
        company: null,
        platformProvider: 'mock-email',
      });
      expect(await harness.prisma.notificationProviderConfig.count()).toBe(0);
      await as(ownerA).delete(api('notification-providers/EMAIL')).expect(404);
    });
  });

  // ===========================================================================
  describe('delivery receipts', () => {
    async function sentThroughCompanySendGrid() {
      const saved = await as(ownerA)
        .put(api('notification-providers/EMAIL'), sendgridConfig())
        .expect(200);
      mockFetch(
        () => new Response(null, { status: 202, headers: { 'x-message-id': `sg-${unique}` } }),
      );
      const base = await paymentReceipt();
      await run();
      const [row] = await rowsFor(base);
      expect(row!.status).toBe('SENT');
      return {
        configId: saved.body.data.company.id as string,
        row: row!,
        messageId: `sg-${unique}`,
      };
    }

    it('marks a message DELIVERED from a signed SendGrid event, once', async () => {
      const { configId, row, messageId } = await sentThroughCompanySendGrid();
      const events = [
        {
          event: 'processed',
          notification_id: row.id,
          sg_message_id: `${messageId}.filter1`,
          timestamp: 1,
        },
        {
          event: 'delivered',
          notification_id: row.id,
          sg_message_id: `${messageId}.filter1`,
          timestamp: 2,
        },
        { event: 'open', notification_id: row.id, timestamp: 3 },
      ];
      const res = await signedSendGrid(events, configId).expect(200);
      expect(res.body.data).toMatchObject({ received: 3 });

      const delivered = await harness.prisma.notification.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(delivered).toMatchObject({ status: 'DELIVERED', providerStatus: 'delivered' });
      expect(delivered.deliveredAt).not.toBeNull();

      // A replay, or a late bounce, changes nothing about a delivered message.
      const replay = await signedSendGrid(
        [
          {
            event: 'bounce',
            notification_id: row.id,
            sg_message_id: `${messageId}.filter1`,
            timestamp: 4,
          },
        ],
        configId,
      ).expect(200);
      expect(replay.body.data.applied).toBe(0);
      expect(
        (await harness.prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).status,
      ).toBe('DELIVERED');
    });

    it('records a bounce as FAILED, without the provider’s text (it quotes the address)', async () => {
      const { configId, row } = await sentThroughCompanySendGrid();
      await signedSendGrid(
        [
          {
            event: 'bounce',
            notification_id: row.id,
            reason: `550 ${row.recipientAddress} unknown`,
            timestamp: 5,
          },
        ],
        configId,
      ).expect(200);
      const failed = await harness.prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
      expect(failed.status).toBe('FAILED');
      expect(failed.failureReason).not.toContain(row.recipientAddress);
    });

    it('refuses an unsigned or wrongly signed receipt, and an unknown source', async () => {
      const { configId, row } = await sentThroughCompanySendGrid();
      const raw = JSON.stringify([{ event: 'delivered', notification_id: row.id, timestamp: 1 }]);
      await request(http)
        .post(`/api/v1/notifications/receipts/sendgrid/${configId}`)
        .set('Content-Type', 'application/json')
        .send(raw)
        .expect(401);
      await request(http)
        .post(`/api/v1/notifications/receipts/sendgrid/${configId}`)
        .set('Content-Type', 'application/json')
        .set('X-Twilio-Email-Event-Webhook-Signature', 'MEUCIQ==')
        .set('X-Twilio-Email-Event-Webhook-Timestamp', String(Math.floor(Date.now() / 1000)))
        .send(raw)
        .expect(401);
      // The platform has no SendGrid account in this suite, so nothing verifies.
      await signedSendGrid([{ event: 'delivered', notification_id: row.id }], 'platform').expect(
        401,
      );
      await signedSendGrid(
        [{ event: 'delivered', notification_id: row.id }],
        'not-a-source',
      ).expect(401);
      expect(
        (await harness.prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).status,
      ).toBe('SENT');
    });

    it('never lets one company’s webhook key touch another company’s messages', async () => {
      const { configId } = await sentThroughCompanySendGrid();
      const base = await paymentReceipt(world.companyB.id, world.companyB.customerId);
      await run(world.companyB.id);
      const [other] = await rowsFor(base);
      expect(other!.status).toBe('SENT');

      const res = await signedSendGrid(
        [{ event: 'delivered', notification_id: other!.id, timestamp: 1 }],
        configId,
      ).expect(200);
      expect(res.body.data).toMatchObject({ applied: 0, ignored: 1 });
      expect(
        (await harness.prisma.notification.findUniqueOrThrow({ where: { id: other!.id } })).status,
      ).toBe('SENT');
    });

    it('marks an SMS DELIVERED from a signed Twilio status callback', async () => {
      await harness.prisma.companySettings.updateMany({
        where: { companyId: world.companyA.id },
        data: { notificationEventChannels: { 'payment.completed': ['SMS'] } },
      });
      const saved = await as(ownerA)
        .put(api('notification-providers/SMS'), twilioConfig())
        .expect(200);
      const configId = saved.body.data.company.id as string;
      const calls = mockFetch(
        () => new Response(JSON.stringify({ sid: 'SM-test-1', status: 'queued' }), { status: 201 }),
      );

      const base = await paymentReceipt();
      await run();
      const [row] = await rowsFor(base);
      expect(row).toMatchObject({
        channel: 'SMS',
        status: 'SENT',
        provider: 'twilio',
        providerMessageId: 'SM-test-1',
      });
      const form = new URLSearchParams(calls.mock.calls[0]![1]!.body as string);
      const path = `/api/v1/notifications/receipts/twilio/${configId}?n=${row!.id}`;
      expect(form.get('StatusCallback')).toBe(`${BASE}${path}`);

      const params = {
        MessageSid: 'SM-test-1',
        MessageStatus: 'delivered',
        AccountSid: ACCOUNT_SID,
      };
      await request(http)
        .post(path)
        .type('form')
        .set('X-Twilio-Signature', twilioSignature('wrong-token', `${BASE}${path}`, params))
        .send(params)
        .expect(401);
      await request(http)
        .post(path)
        .type('form')
        .set('X-Twilio-Signature', twilioSignature(AUTH_TOKEN, `${BASE}${path}`, params))
        .send(params)
        .expect(200);
      const delivered = await harness.prisma.notification.findUniqueOrThrow({
        where: { id: row!.id },
      });
      expect(delivered).toMatchObject({ status: 'DELIVERED', providerStatus: 'delivered' });
    });
  });

  // ===========================================================================
  describe('access control', () => {
    it('lets an admin without billing rights verify and retry, but not change who sends', async () => {
      await as(ownerA).put(api('notification-providers/EMAIL'), sendgridConfig()).expect(200);
      const admin = await member(SYSTEM_ROLES.ADMIN);
      await as(admin).get(api('notification-providers')).expect(200);
      await as(admin).put(api('notification-providers/EMAIL'), sendgridConfig()).expect(403);
      await as(admin).delete(api('notification-providers/EMAIL')).expect(403);
      mockFetch(() => new Response(JSON.stringify({ scopes: ['mail.send'] }), { status: 200 }));
      await as(admin).post(api('notification-providers/EMAIL/verify')).expect(200);
    });

    it('lets a read-only member see masked settings but not verify, configure or retry', async () => {
      await as(ownerA).put(api('notification-providers/EMAIL'), sendgridConfig()).expect(200);
      email.failNext(1, { retryable: false });
      mockFetch(() => new Response('', { status: 500 }));
      const base = await paymentReceipt();
      await run();
      const [row] = await rowsFor(base);

      const reader = await member(SYSTEM_ROLES.READ_ONLY);
      const listed = await as(reader).get(api('notification-providers')).expect(200);
      expect(listed.text).not.toContain(API_KEY);
      await as(reader).put(api('notification-providers/EMAIL'), sendgridConfig()).expect(403);
      await as(reader).post(api('notification-providers/EMAIL/verify')).expect(403);
      await as(reader)
        .post(api(`notifications/${row!.id}/retry`))
        .expect(403);
    });

    it('keeps receptionists and employees out, and anonymous callers', async () => {
      for (const role of [SYSTEM_ROLES.RECEPTIONIST, SYSTEM_ROLES.EMPLOYEE]) {
        const token = await member(role);
        await as(token).get(api('notification-providers')).expect(403);
        await as(token).put(api('notification-providers/SMS'), twilioConfig()).expect(403);
      }
      await request(http).get(api('notification-providers')).expect(401);
      await request(http)
        .put(api('notification-providers/EMAIL'))
        .send(sendgridConfig())
        .expect(401);
    });

    it('keeps each company’s accounts and messages to itself', async () => {
      await as(ownerA).put(api('notification-providers/EMAIL'), sendgridConfig()).expect(200);
      mockFetch(() => new Response('', { status: 500 }));
      const base = await paymentReceipt();
      await run();
      const [row] = await rowsFor(base);

      // Company B's owner, at company A's URLs: not a member, so not found.
      await as(ownerB).get(api('notification-providers')).expect(404);
      await as(ownerB).put(api('notification-providers/EMAIL'), sendgridConfig()).expect(404);
      await as(ownerB)
        .post(api(`notifications/${row!.id}/retry`))
        .expect(404);
      // At its own URLs, A's notification does not exist.
      await as(ownerB)
        .post(api(`notifications/${row!.id}/retry`, world.companyB.id))
        .expect(404);
      const ownList = await as(ownerB)
        .get(api('notification-providers', world.companyB.id))
        .expect(200);
      expect(ownList.body.data.channels[0].company).toBeNull();
    });

    it('shows the platform’s providers to an operator with operator rights only, without secrets', async () => {
      const passwordHash = (
        await harness.prisma.userAccount.findFirstOrThrow({ where: { id: world.userA.id } })
      ).passwordHash!;
      const opsEmail = `notify-ops-${unique++}@platform.test`;
      await seedPlatformUser(
        harness.prisma,
        opsEmail,
        'Notify Ops',
        passwordHash,
        `NOTIFY_OPS_${unique}`,
        [PLATFORM_PERMISSIONS.OPERATOR_MANAGE],
      );
      const ops = await harness.platformToken(opsEmail);
      const res = await as(ops).get('/api/v1/platform/notification-providers').expect(200);
      expect(res.body.data).toMatchObject({
        secretsEncryptionConfigured: true,
        receiptBaseUrlConfigured: true,
        channels: [
          { channel: 'EMAIL', provider: 'mock-email', configured: true },
          { channel: 'SMS', configured: true },
          { channel: 'PUSH', configured: true },
        ],
      });

      const admin = await harness.platformToken(world.platformAdmin.email);
      await as(admin).get('/api/v1/platform/notification-providers').expect(403);
      const company = await as(ownerA).get('/api/v1/platform/notification-providers');
      expect([401, 403, 404]).toContain(company.status);
    });
  });
});

/**
 * A platform with no SMS or push provider (`SMS_PROVIDER=none`): nothing is
 * created for those channels — no row pretends a message went anywhere — until
 * the company brings its own account.
 */
describe('notification providers: unconfigured channels', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let ownerA: string;
  let unique = 0;

  beforeAll(async () => {
    harness = await createTestHarness({
      override: (builder) =>
        builder
          .overrideProvider(NOTIFICATION_PROVIDERS)
          .useFactory({
            factory: (mail: EmailNotificationProvider) => [mail],
            inject: [EmailNotificationProvider],
          }),
    });
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await harness.close();
  });

  async function booked() {
    const dedupeBase = `none-${Date.now()}-${unique++}`;
    await harness.prisma.outboxEvent.create({
      data: {
        companyId: world.companyA.id,
        type: 'appointment.created',
        payload: { appointmentId: world.companyA.appointmentId, dedupeBase },
      },
    });
    await harness.app.get(NotificationSchedulerService).runOnce({ companyId: world.companyA.id });
    return harness.prisma.notification.findMany({
      where: { dedupeKey: { startsWith: `${dedupeBase}:` } },
      orderBy: { channel: 'asc' },
    });
  }

  it('creates nothing on a channel no one can send, and says so in the settings', async () => {
    expect((await booked()).map((r) => r.channel)).toEqual(['EMAIL']);
    const listed = await request(http)
      .get(`/api/v1/companies/${world.companyA.id}/notification-providers`)
      .set('Authorization', `Bearer ${ownerA}`)
      .expect(200);
    expect(listed.body.data.channels).toEqual([
      expect.objectContaining({ channel: 'EMAIL', active: 'platform' }),
      expect.objectContaining({ channel: 'SMS', active: 'none', platformProvider: null }),
      expect.objectContaining({ channel: 'PUSH', active: 'none', supportedProviders: [] }),
    ]);
  });

  it('starts sending SMS once the company connects its own Twilio account', async () => {
    await request(http)
      .put(`/api/v1/companies/${world.companyA.id}/notification-providers/SMS`)
      .set('Authorization', `Bearer ${ownerA}`)
      .send({
        provider: 'twilio',
        secrets: { authToken: 'twilio-test-token-not-real-0000' },
        settings: { accountSid: `AC${'b'.repeat(32)}`, fromNumber: '+15005550006' },
      })
      .expect(200);
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ sid: 'SM-x', status: 'accepted' }), { status: 201 }),
        ),
      );
    const rows = await booked();
    expect(rows.map((r) => [r.channel, r.status, r.provider])).toEqual([
      ['EMAIL', 'SENT', 'mock-email'],
      ['SMS', 'SENT', 'twilio'],
    ]);
  });
});
