import * as argon2 from 'argon2';
import request from 'supertest';
import type { Server } from 'node:http';
import { stepAt, totpCode } from '../src/auth/totp';
import { AppConfig } from '../src/config';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedPlatformUser, seedWorld, TEST_PASSWORD } from './support/seed';

/**
 * Platform operators' second factor: enrolment, sign-in with a code, replay
 * refusal, lockout counting, and the production rule that an operator without
 * a second factor cannot sign in at all.
 */
describe('platform MFA', () => {
  let harness: TestHarness;
  let http: Server;
  let passwordHash: string;
  let unique = 0;

  const login = (email: string, mfaCode?: string) =>
    request(http)
      .post('/api/v1/platform/auth/login')
      .send({ email, password: TEST_PASSWORD, ...(mfaCode ? { mfaCode } : {}) });

  async function operator() {
    const email = `ops-${Date.now()}-${unique++}@example.com`;
    const user = await seedPlatformUser(harness.prisma, email, 'Ops', passwordHash, 'MFA_TEST', [
      'platform:company:list',
    ]);
    return { ...user, email };
  }

  /** Enrol through the API, as an operator would. Returns the secret and the step used. */
  async function enrol(email: string) {
    const token = (await login(email).expect(200)).body.data.accessToken as string;
    const auth = { Authorization: `Bearer ${token}` };
    const setup = await request(http).post('/api/v1/platform/auth/mfa/setup').set(auth).expect(200);
    const secret = setup.body.data.secret as string;
    const step = stepAt();
    await request(http)
      .post('/api/v1/platform/auth/mfa/confirm')
      .set(auth)
      .send({ code: totpCode(secret, step) })
      .expect(200);
    return { secret, step, setup: setup.body.data };
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    await seedWorld(harness.prisma);
    passwordHash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id });
  });

  afterAll(async () => harness.close());

  it('enrols: the secret is shown once and stored sealed, never in the clear', async () => {
    const op = await operator();
    const token = (await login(op.email).expect(200)).body.data.accessToken as string;
    const status = await request(http)
      .get('/api/v1/platform/auth/mfa')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(status.body.data.enrolled).toBe(false);

    const { secret, setup } = await enrol(op.email);
    expect(setup.otpauthUri).toMatch(/^otpauth:\/\/totp\/Undarga%20Platform%3A/);
    const row = await harness.prisma.platformUser.findUniqueOrThrow({ where: { id: op.id } });
    expect(row.mfaEnrolledAt).not.toBeNull();
    expect(row.mfaSecret).not.toContain(secret);
    expect(row.mfaSecret!.startsWith('v1.')).toBe(true);
  });

  it('refuses a wrong code at enrolment', async () => {
    const op = await operator();
    const token = (await login(op.email).expect(200)).body.data.accessToken as string;
    const auth = { Authorization: `Bearer ${token}` };
    const setup = await request(http).post('/api/v1/platform/auth/mfa/setup').set(auth).expect(200);
    const wrong = totpCode(setup.body.data.secret, stepAt() + 5);
    await request(http)
      .post('/api/v1/platform/auth/mfa/confirm')
      .set(auth)
      .send({ code: wrong })
      .expect(400);
  });

  it('asks an enrolled operator for the code, then accepts it once', async () => {
    const op = await operator();
    const { secret, step } = await enrol(op.email);

    const asked = await login(op.email).expect(401);
    expect(asked.body.error.code).toBe('MFA_REQUIRED');

    // The step after the one spent at enrolment (one step of drift is allowed).
    const code = totpCode(secret, step + 1);
    const ok = await login(op.email, code).expect(200);
    expect(ok.body.data.accessToken).toEqual(expect.any(String));

    // The same code again: replay, refused.
    const replay = await login(op.email, code).expect(401);
    expect(replay.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('counts a wrong code towards the lockout and audits it', async () => {
    const op = await operator();
    const { secret, step } = await enrol(op.email);
    await login(op.email, totpCode(secret, step + 9)).expect(401);

    const row = await harness.prisma.platformUser.findUniqueOrThrow({ where: { id: op.id } });
    expect(row.failedLoginCount).toBe(1);
    const audit = await harness.prisma.auditLog.findFirst({
      where: { action: 'platform.mfa_failed', resourceId: op.id },
    });
    expect(audit?.actorLabel).toBe('system:anonymous');
  });

  it('does not let an enrolled operator start setup again (that would swap the secret)', async () => {
    const op = await operator();
    const { secret, step } = await enrol(op.email);
    const token = (await login(op.email, totpCode(secret, step + 1)).expect(200)).body.data
      .accessToken as string;
    await request(http)
      .post('/api/v1/platform/auth/mfa/setup')
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });
});

describe('platform MFA — required', () => {
  let harness: TestHarness;
  let http: Server;
  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    await seedWorld(harness.prisma);
    // The environment is parsed once per process; flip the one setting the way
    // production has it.
    const config = harness.app.get(AppConfig);
    const real = config.auth;
    jest.spyOn(config, 'auth', 'get').mockReturnValue({ ...real, platformMfaRequired: true });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await harness.close();
  });

  it('refuses an operator who has no second factor, even with the right password', async () => {
    const hash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id });
    const email = `nomfa-${Date.now()}@example.com`;
    await seedPlatformUser(harness.prisma, email, 'No MFA', hash, 'MFA_TEST_REQ', []);

    const res = await request(http)
      .post('/api/v1/platform/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(403);
    expect(res.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
  });

  it('still refuses a wrong password first, with nothing about MFA', async () => {
    const hash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id });
    const email = `nomfa2-${Date.now()}@example.com`;
    await seedPlatformUser(harness.prisma, email, 'No MFA', hash, 'MFA_TEST_REQ', []);
    const res = await request(http)
      .post('/api/v1/platform/auth/login')
      .send({ email, password: 'not-the-password-at-all' })
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});
