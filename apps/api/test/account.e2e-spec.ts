import request from 'supertest';
import type { Server } from 'node:http';
import { MailerService, type AccountLinkEmail } from '../src/mail/mailer.service';
import { TokenHashService } from '../src/auth/token-hash.service';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, TEST_PASSWORD, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * ACCOUNT LIFECYCLE
 * ===========================================================================
 *
 * Email verification, password reset, password change, session revocation.
 *
 * Delivery is captured rather than mocked away: the test reads the link out of
 * MailerService by spying on it, which means the token under test is the one
 * the flow actually produced, hashed and stored the way production does.
 */
describe('account lifecycle', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let sent: AccountLinkEmail[];

  let unique = 0;
  const nextEmail = () => `account-${Date.now()}-${unique++}@example.com`;

  /** Create an ACTIVE account with a known password. */
  async function makeUser(overrides: { emailVerifiedAt?: Date | null } = {}) {
    const known = await harness.prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });

    return harness.prisma.userAccount.create({
      data: {
        email: nextEmail(),
        fullName: 'Account Person',
        status: 'ACTIVE',
        passwordHash: known.passwordHash,
        emailVerifiedAt: overrides.emailVerifiedAt ?? null,
      },
      select: { id: true, email: true },
    });
  }

  /** The token out of the most recent link, as the recipient would read it. */
  function lastToken(): string {
    const link = sent.at(-1)?.link;
    if (!link) throw new Error('no link was sent');
    const token = new URL(link).searchParams.get('token');
    if (!token) throw new Error(`link carried no token: ${link}`);
    return token;
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);

    sent = [];
    const mailer = harness.app.get(MailerService);
    jest.spyOn(mailer, 'sendAccountLink').mockImplementation(async (email) => {
      sent.push(email);
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    sent = [];
  });

  // ===========================================================================
  describe('email verification', () => {
    it('sends a link and marks the address verified', async () => {
      const user = await makeUser();

      await request(http)
        .post('/api/v1/auth/resend-verification')
        .send({ email: user.email })
        .expect(202);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: user.email, kind: 'email-verification' });

      const res = await request(http)
        .post('/api/v1/auth/verify-email')
        .send({ token: lastToken() })
        .expect(200);

      expect(res.body.data.email).toBe(user.email);

      const after = await harness.prisma.userAccount.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.emailVerifiedAt).not.toBeNull();
    });

    it('normalises the address, so casing cannot dodge the lookup', async () => {
      const user = await makeUser();

      await request(http)
        .post('/api/v1/auth/resend-verification')
        .send({ email: user.email.toUpperCase() })
        .expect(202);

      expect(sent).toHaveLength(1);
    });

    it('refuses a token that has already been used', async () => {
      const user = await makeUser();
      await request(http)
        .post('/api/v1/auth/resend-verification')
        .send({ email: user.email })
        .expect(202);

      const token = lastToken();
      await request(http).post('/api/v1/auth/verify-email').send({ token }).expect(200);

      const res = await request(http).post('/api/v1/auth/verify-email').send({ token }).expect(400);
      expect(res.body.error.code).toBe('ACCOUNT_TOKEN_INVALID');
    });

    it('refuses an expired token with a distinguishable code', async () => {
      const user = await makeUser();
      await request(http)
        .post('/api/v1/auth/resend-verification')
        .send({ email: user.email })
        .expect(202);

      const token = lastToken();
      const hashes = harness.app.get(TokenHashService);
      await harness.prisma.userToken.update({
        where: { tokenHash: hashes.hash(token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await request(http).post('/api/v1/auth/verify-email').send({ token }).expect(410);
      // Expiry is the one failure worth distinguishing: it is actionable, and
      // it leaks nothing an attacker could not learn by waiting.
      expect(res.body.error.code).toBe('ACCOUNT_TOKEN_EXPIRED');
    });

    it('refuses an unknown token', async () => {
      const res = await request(http)
        .post('/api/v1/auth/verify-email')
        .send({ token: 'z'.repeat(43) })
        .expect(400);

      expect(res.body.error.code).toBe('ACCOUNT_TOKEN_INVALID');
    });

    it('retires the previous link when a new one is issued', async () => {
      // Otherwise clicking "resend" three times leaves three working links and
      // the user believes there is one.
      const user = await makeUser();
      await request(http)
        .post('/api/v1/auth/resend-verification')
        .send({ email: user.email })
        .expect(202);
      const first = lastToken();

      await request(http)
        .post('/api/v1/auth/resend-verification')
        .send({ email: user.email })
        .expect(202);
      const second = lastToken();

      expect(second).not.toBe(first);
      await request(http).post('/api/v1/auth/verify-email').send({ token: first }).expect(400);
      await request(http).post('/api/v1/auth/verify-email').send({ token: second }).expect(200);
    });

    it('sends nothing for an unknown address, and says the same thing', async () => {
      const res = await request(http)
        .post('/api/v1/auth/resend-verification')
        .send({ email: 'nobody-at-all@example.com' })
        .expect(202);

      expect(sent).toHaveLength(0);
      expect(res.body.data.message).toMatch(/If an account exists/);
    });
  });

  // ===========================================================================
  describe('password reset', () => {
    it('sends a link, sets the password, and lets the user sign in with it', async () => {
      const user = await makeUser();

      await request(http)
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(202);

      expect(sent[0]).toMatchObject({ to: user.email, kind: 'password-reset' });

      await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ token: lastToken(), newPassword: 'a-brand-new-password' })
        .expect(204);

      await request(http)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'a-brand-new-password' })
        .expect(200);

      // And the old one is dead.
      await request(http)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(401);
    });

    it('revokes every existing session', async () => {
      /**
       * The property that makes a reset worth doing. If the password leaked,
       * so did every session it created — changing the credential while leaving
       * those alive puts the attacker exactly where they were.
       */
      const user = await makeUser();

      const login = await request(http)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      const oldToken = login.body.data.accessToken;
      const oldCookie = login.headers['set-cookie'];

      // The session works right now.
      await request(http)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${oldToken}`)
        .expect(200);

      await request(http)
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(202);
      await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ token: lastToken(), newPassword: 'a-brand-new-password' })
        .expect(204);

      // The access token is dead immediately, not at expiry — that is the
      // in-process deny list, not just the database revocation.
      await request(http)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${oldToken}`)
        .expect(401);

      // And the refresh cookie cannot resurrect it.
      await request(http)
        .post('/api/v1/auth/refresh')
        .set('Cookie', Array.isArray(oldCookie) ? oldCookie : [String(oldCookie)])
        .expect(401);
    });

    it('refuses a reused reset token', async () => {
      const user = await makeUser();
      await request(http)
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(202);
      const token = lastToken();

      await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: 'a-brand-new-password' })
        .expect(204);

      await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: 'another-new-password' })
        .expect(400);
    });

    it('refuses an expired reset token', async () => {
      const user = await makeUser();
      await request(http)
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(202);

      const token = lastToken();
      const hashes = harness.app.get(TokenHashService);
      await harness.prisma.userToken.update({
        where: { tokenHash: hashes.hash(token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: 'a-brand-new-password' })
        .expect(410);
    });

    it('rejects a password shorter than the policy', async () => {
      const user = await makeUser();
      await request(http)
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(202);

      const res = await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ token: lastToken(), newPassword: 'short' })
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    describe('enumeration resistance', () => {
      it('answers identically for a known and an unknown address', async () => {
        const user = await makeUser();

        const known = await request(http)
          .post('/api/v1/auth/forgot-password')
          .send({ email: user.email })
          .expect(202);
        const unknown = await request(http)
          .post('/api/v1/auth/forgot-password')
          .send({ email: 'definitely-not-here@example.com' })
          .expect(202);

        // Byte-identical apart from the request id. An endpoint that answered
        // differently would hand an attacker the exact input list for a
        // credential-stuffing run.
        expect(known.body.data).toEqual(unknown.body.data);
        expect(known.status).toBe(unknown.status);
      });

      it('sends nothing for an account that has never set a password', async () => {
        // A provisioning placeholder. "Reset" is the wrong flow — the
        // invitation is what completes it.
        const placeholder = await harness.prisma.userAccount.create({
          data: { email: nextEmail(), fullName: 'Placeholder', status: 'INVITED' },
        });

        await request(http)
          .post('/api/v1/auth/forgot-password')
          .send({ email: placeholder.email })
          .expect(202);

        expect(sent).toHaveLength(0);
      });

      it('sends nothing for a disabled account', async () => {
        const user = await makeUser();
        await harness.prisma.userAccount.update({
          where: { id: user.id },
          data: { status: 'DISABLED' },
        });

        await request(http)
          .post('/api/v1/auth/forgot-password')
          .send({ email: user.email })
          .expect(202);

        expect(sent).toHaveLength(0);
      });
    });
  });

  // ===========================================================================
  describe('change password', () => {
    async function signedIn() {
      const user = await makeUser();
      const login = await request(http)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      return { user, token: login.body.data.accessToken as string };
    }

    it('changes the password and keeps the caller signed in', async () => {
      const { user, token } = await signedIn();

      await request(http)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-password' })
        .expect(204);

      // Their own session survives — otherwise every password change ends with
      // "now sign in again on the device you are holding".
      await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200);

      await request(http)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'a-brand-new-password' })
        .expect(200);
    });

    it('revokes the user’s OTHER sessions', async () => {
      const { user, token } = await signedIn();

      const other = await request(http)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      const otherToken = other.body.data.accessToken;

      await request(http)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-password' })
        .expect(204);

      await request(http)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(401);
    });

    it('requires the current password', async () => {
      // An access token left open on a shared machine must not be enough to
      // lock the real owner out.
      const { token } = await signedIn();

      const res = await request(http)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'not-the-password', newPassword: 'a-brand-new-password' })
        .expect(401);

      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('refuses to set the same password again', async () => {
      const { token } = await signedIn();

      await request(http)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD })
        .expect(400);
    });

    it('is closed to anonymous callers', async () => {
      await request(http)
        .post('/api/v1/auth/change-password')
        .send({ currentPassword: 'x', newPassword: 'a-brand-new-password' })
        .expect(401);
    });
  });

  // ===========================================================================
  describe('logout everywhere', () => {
    it('kills every session including the caller’s, and clears the cookie', async () => {
      const user = await makeUser();

      const first = await request(http)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      const second = await request(http)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);

      const res = await request(http)
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${first.body.data.accessToken}`)
        .expect(200);

      expect(res.body.data.revoked).toBeGreaterThanOrEqual(2);

      for (const token of [first.body.data.accessToken, second.body.data.accessToken]) {
        await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
      }

      // The cookie must go too, or the next page load attempts a refresh that
      // is guaranteed to fail.
      const cleared = String(res.headers['set-cookie']);
      expect(cleared).toMatch(/undarga_rt=/);
    });
  });

  // ===========================================================================
  describe('the profile endpoint', () => {
    async function signedIn() {
      const user = await makeUser();
      const login = await request(http)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      return { user, token: login.body.data.accessToken as string };
    }

    it('returns the account without any credential column', async () => {
      const { user, token } = await signedIn();

      const res = await request(http)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.data).toMatchObject({ id: user.id, email: user.email, status: 'ACTIVE' });
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/passwordHash|password_hash|mfaSecret|\$argon2/);
    });

    it('updates the fields a user owns', async () => {
      const { token } = await signedIn();

      const res = await request(http)
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ fullName: 'Renamed Person', phone: '+976 9999 9999' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        fullName: 'Renamed Person',
        phone: '+976 9999 9999',
      });
    });

    describe('mass assignment', () => {
      it.each([
        ['status', { status: 'ACTIVE' }],
        ['emailVerifiedAt', { emailVerifiedAt: new Date().toISOString() }],
        ['passwordHash', { passwordHash: 'x' }],
        ['email', { email: 'new@example.com' }],
        ['id', { id: '018f0000-0000-7000-8000-0000000000ff' }],
      ])('rejects a %s field rather than ignoring it', async (_label, patch) => {
        // A strict schema rather than a silent drop: an attempt should be a
        // 400 the client can see, not a no-op the attacker retries differently.
        const { token } = await signedIn();

        await request(http)
          .patch('/api/v1/users/me')
          .set('Authorization', `Bearer ${token}`)
          .send({ fullName: 'Legit', ...patch })
          .expect(400);
      });

      it('cannot verify its own email through the profile endpoint', async () => {
        const { user, token } = await signedIn();

        await request(http)
          .patch('/api/v1/users/me')
          .set('Authorization', `Bearer ${token}`)
          .send({ emailVerifiedAt: new Date().toISOString() })
          .expect(400);

        const after = await harness.prisma.userAccount.findUniqueOrThrow({
          where: { id: user.id },
        });
        expect(after.emailVerifiedAt).toBeNull();
      });
    });

    it('is closed to anonymous callers', async () => {
      await request(http).get('/api/v1/users/me').expect(401);
      await request(http).patch('/api/v1/users/me').send({ fullName: 'x' }).expect(401);
    });
  });

  // ===========================================================================
  describe('tokens are never handled in the clear', () => {
    it('stores only the HMAC', async () => {
      const user = await makeUser();
      await request(http)
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(202);

      const token = lastToken();
      const rows = await harness.prisma.userToken.findMany({
        where: { userAccountId: user.id },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).not.toBe(token);
      expect(rows[0]!.tokenHash).not.toContain(token);
    });

    it('keeps a verification token from being spent as a reset token', async () => {
      // If the two were interchangeable, a verification link — which is longer
      // lived and sent more freely — would be an account takeover.
      const user = await makeUser();
      await request(http)
        .post('/api/v1/auth/resend-verification')
        .send({ email: user.email })
        .expect(202);

      await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ token: lastToken(), newPassword: 'a-brand-new-password' })
        .expect(400);
    });
  });

  // ===========================================================================
  describe('the per-account ceiling', () => {
    /**
     * A second limit, on a different axis from the edge rate limiter.
     *
     * The throttler caps requests per IP; this caps links per ACCOUNT. An
     * attacker with a botnet defeats the first and not the second, and the
     * thing being protected — somebody else's inbox — only cares about the
     * second.
     *
     * It fails silently: the response is unchanged, so this cannot be used to
     * probe whether an address is being targeted.
     */
    it('stops minting links after five in fifteen minutes', async () => {
      const user = await makeUser();

      for (let i = 0; i < 5; i++) {
        await request(http)
          .post('/api/v1/auth/forgot-password')
          .send({ email: user.email })
          .expect(202);
      }
      expect(sent).toHaveLength(5);

      const res = await request(http)
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(202);

      // Same status, same body, no sixth email.
      expect(sent).toHaveLength(5);
      expect(res.body.data.message).toMatch(/If an account exists/);
    });
  });
});

/**
 * The edge rate limiter, in its own harness.
 *
 * Everything above runs with throttling overridden, because low limits plus a
 * single source address makes every test's outcome depend on how many ran
 * before it. This block turns it back on to prove the guard is actually wired
 * into the pipeline — the one property that a library cannot test for us.
 */
describe('rate limiting', () => {
  let harness: TestHarness;
  let http: Server;

  beforeAll(async () => {
    harness = await createTestHarness({ throttling: true });
    http = harness.app.getHttpServer() as Server;

    const mailer = harness.app.get(MailerService);
    jest.spyOn(mailer, 'sendAccountLink').mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('refuses a burst of password-reset requests', async () => {
    const email = `burst-${Date.now()}@example.com`;
    const statuses: number[] = [];

    // The limit is 3/minute. The address does not need to exist — throttling
    // runs before authentication and before any lookup, which is the point:
    // the endpoints most worth limiting are the ones with no session.
    for (let i = 0; i < 6; i++) {
      const res = await request(http).post('/api/v1/auth/forgot-password').send({ email });
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 202).length).toBeLessThanOrEqual(3);
    expect(statuses).toContain(429);
  });

  it('refuses a burst of login attempts', async () => {
    // Credential stuffing: one attempt each against many addresses never trips
    // the per-account lockout, so the IP limit is what makes it expensive.
    const statuses: number[] = [];

    for (let i = 0; i < 14; i++) {
      const res = await request(http)
        .post('/api/v1/auth/login')
        .send({ email: `stuffing-${i}@example.com`, password: 'whatever' });
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
  });
});
