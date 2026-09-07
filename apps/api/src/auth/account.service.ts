import { Injectable, Logger } from '@nestjs/common';
import type { UserTokenPurpose } from '@prisma/client';
import { AppConfig } from '../config';
import { AuditService } from '../audit/audit.service';
import {
  AccountTokenExpiredError,
  AccountTokenInvalidError,
  InvalidCredentialsError,
  ValidationFailedError,
} from '../common/errors';
import { MailerService } from '../mail/mailer.service';
import { IdentityRepository } from './identity.repository';
import { normalizeEmail } from './normalize-email';
import { PasswordService } from './password.service';
import { SessionDenyList } from './session-deny-list';
import { TokenHashService } from './token-hash.service';
import { UserTokenRepository } from './user-token.repository';

/**
 * Account lifecycle: verifying an address, resetting a forgotten password,
 * changing a known one, and ending sessions.
 *
 * Separate from AuthService, which is about proving who you are right now.
 * This is about the account itself, and it is the only place that mints
 * one-time tokens.
 *
 * ===========================================================================
 * THE RULE EVERY PUBLIC METHOD HERE FOLLOWS
 * ===========================================================================
 *
 * Never tell an unauthenticated caller whether an address has an account.
 *
 * `forgot-password` and `resend-verification` both take an email and both
 * answer identically whether or not the account exists. That is not politeness:
 * an endpoint that answers differently is an account-enumeration oracle, and
 * the list it yields is exactly the input to a credential-stuffing run. The
 * work is done unconditionally where it is cheap, so response TIMING does not
 * leak the answer either.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly identity: IdentityRepository,
    private readonly tokens: UserTokenRepository,
    private readonly passwords: PasswordService,
    private readonly hashes: TokenHashService,
    private readonly denyList: SessionDenyList,
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // Email verification
  // ---------------------------------------------------------------------------

  /**
   * Send a verification link, if there is anything to send it to.
   *
   * Always resolves. The caller returns the same message either way.
   */
  async requestEmailVerification(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const account = await this.identity.findStaffAccountForInvite(email);

    if (!account || account.deletedAt || account.status === 'DISABLED') return;

    // Already verified: nothing to do, and re-sending would let someone with a
    // list of addresses keep mail flowing to strangers.
    const profile = await this.identity.findStaffProfile(account.id);
    if (!profile || profile.emailVerifiedAt) return;

    if (await this.isIssuingTooFast(account.id, 'EMAIL_VERIFICATION')) return;

    await this.issueAndSend(account.id, email, 'EMAIL_VERIFICATION');
  }

  /**
   * Consume a verification token.
   *
   * Unlike the request side this DOES report failure, because the caller is
   * holding a token rather than guessing an address — there is nothing to
   * enumerate, and "your link expired" is the only useful thing to say.
   */
  async verifyEmail(token: string): Promise<{ email: string }> {
    const record = await this.consumeToken(token, 'EMAIL_VERIFICATION');

    await this.identity.markEmailVerified(record.userAccountId);

    await this.audit.record({
      action: 'auth.email_verified',
      resourceType: 'user_account',
      resourceId: record.userAccountId,
      platformLevel: true,
    });

    return { email: record.email };
  }

  // ---------------------------------------------------------------------------
  // Password reset
  // ---------------------------------------------------------------------------

  /** Same contract as requestEmailVerification: always resolves, never reveals. */
  async requestPasswordReset(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const account = await this.identity.findStaffAccountForInvite(email);

    if (!account || account.deletedAt || account.status === 'DISABLED') return;

    // An account with no password has never been activated — it is a
    // placeholder waiting on an invitation, and "reset" is the wrong flow. Send
    // nothing; the invitation is what completes it.
    if (!account.hasPassword) return;

    if (await this.isIssuingTooFast(account.id, 'PASSWORD_RESET')) return;

    await this.issueAndSend(account.id, email, 'PASSWORD_RESET');
  }

  /**
   * Set a new password from a reset token.
   *
   * Every session dies, including any the attacker may hold. Resetting the
   * credential while leaving the sessions it created alive would defeat the
   * point of resetting it.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    this.assertPasswordPolicy(newPassword);

    const record = await this.consumeToken(token, 'PASSWORD_RESET');
    const passwordHash = await this.passwords.hash(newPassword);

    await this.identity.updateStaffPassword(record.userAccountId, passwordHash);

    // Any other outstanding reset links die too — otherwise a second link,
    // issued before this one was used, still works afterwards.
    await this.tokens.consumeAllFor(record.userAccountId, 'PASSWORD_RESET');

    await this.revokeEverySession(record.userAccountId);

    await this.audit.record({
      action: 'auth.password_reset',
      resourceType: 'user_account',
      resourceId: record.userAccountId,
      platformLevel: true,
    });

    this.logger.log(`Password reset completed for account ${record.userAccountId}`);
  }

  // ---------------------------------------------------------------------------
  // Change password
  // ---------------------------------------------------------------------------

  /**
   * Change a password you already know.
   *
   * The current password is required even though the caller is authenticated:
   * an access token left open on a shared machine must not be enough to lock
   * the real owner out of their own account.
   *
   * Other sessions are revoked; the caller's own is kept, so the ordinary case
   * is not "you changed your password, now sign in again right here".
   */
  async changePassword(
    userAccountId: string,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    this.assertPasswordPolicy(newPassword);

    const account = await this.identity.findStaffCredentialsById(userAccountId);
    if (!account) throw new InvalidCredentialsError();

    const ok = await this.passwords.verify(account.passwordHash, currentPassword);
    if (!ok) {
      await this.audit.record({
        action: 'auth.password_change_failed',
        resourceType: 'user_account',
        resourceId: userAccountId,
        platformLevel: true,
      });
      throw new InvalidCredentialsError();
    }

    if (currentPassword === newPassword) {
      throw new ValidationFailedError({ newPassword: 'Choose a different password.' });
    }

    await this.identity.updateStaffPassword(userAccountId, await this.passwords.hash(newPassword));
    await this.revokeEverySession(userAccountId, currentSessionId);

    await this.audit.record({
      action: 'auth.password_changed',
      resourceType: 'user_account',
      resourceId: userAccountId,
      platformLevel: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  /** Sign out everywhere, including here. */
  async logoutEverywhere(userAccountId: string): Promise<{ revoked: number }> {
    const revoked = await this.revokeEverySession(userAccountId);

    await this.audit.record({
      action: 'auth.sessions_revoked',
      resourceType: 'user_account',
      resourceId: userAccountId,
      platformLevel: true,
      metadata: { count: revoked },
    });

    return { revoked };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Revoke in the database AND in the in-process deny list.
   *
   * Both are needed and they cover different windows. The database revocation
   * stops the next REFRESH; the deny list stops the access token that is
   * already issued and otherwise valid for up to fifteen more minutes.
   *
   * The deny list is per-replica — the known limitation recorded in
   * docs/MULTI-TENANCY.md. Behind more than one instance, revocation is
   * immediate on the replica that handled the request and takes effect
   * elsewhere at the next refresh.
   */
  private async revokeEverySession(userAccountId: string, except?: string): Promise<number> {
    const revoked = await this.identity.revokeAllStaffSessions(userAccountId, except);
    revoked.forEach((id) => this.denyList.revoke(id));
    return revoked.length;
  }

  private assertPasswordPolicy(password: string): void {
    const min = this.config.auth.passwordMinLength;

    if (password.length < min) {
      throw new ValidationFailedError({
        newPassword: `Use at least ${min} characters.`,
      });
    }
  }

  /**
   * A crude per-account ceiling on how often links may be minted.
   *
   * The edge rate limiter (ThrottlerGuard) caps requests per IP; this caps them
   * per ACCOUNT, which is the axis that matters for mailbox flooding — an
   * attacker with a botnet defeats the first and not the second.
   *
   * Returning true silently drops the request. The caller's response does not
   * change, so this cannot be used to probe whether an address is being
   * targeted.
   */
  private async isIssuingTooFast(userAccountId: string, purpose: UserTokenPurpose) {
    const since = new Date(Date.now() - 15 * 60_000);
    const recent = await this.tokens.countRecent(userAccountId, purpose, since);

    if (recent >= 5) {
      this.logger.warn(
        `Suppressing ${purpose} for account ${userAccountId}: ${recent} issued in 15 minutes.`,
      );
      return true;
    }

    return false;
  }

  private async issueAndSend(
    userAccountId: string,
    email: string,
    purpose: UserTokenPurpose,
  ): Promise<void> {
    const token = this.hashes.generate();
    const expiresAt = this.expiryFor(purpose);

    await this.tokens.issue({
      userAccountId,
      purpose,
      tokenHash: this.hashes.hash(token),
      expiresAt,
    });

    await this.mailer.sendAccountLink({
      to: email,
      kind: purpose === 'PASSWORD_RESET' ? 'password-reset' : 'email-verification',
      link: this.linkFor(purpose, token),
      expiresAt,
    });

    await this.audit.record({
      action:
        purpose === 'PASSWORD_RESET' ? 'auth.password_reset_requested' : 'auth.verification_sent',
      resourceType: 'user_account',
      resourceId: userAccountId,
      platformLevel: true,
      // The token is absent on purpose. Never put a live credential into an
      // audit payload and rely on a redaction denylist to catch it.
    });
  }

  private expiryFor(purpose: UserTokenPurpose): Date {
    return purpose === 'PASSWORD_RESET'
      ? new Date(Date.now() + this.config.auth.passwordResetTtlMinutes * 60_000)
      : new Date(Date.now() + this.config.auth.emailVerificationTtlHours * 3_600_000);
  }

  /** Built from the configured web origin, never from the request Host header. */
  private linkFor(purpose: UserTokenPurpose, token: string): string {
    const base = (this.config.app.webAppUrl ?? '').replace(/\/+$/, '');
    const path = purpose === 'PASSWORD_RESET' ? '/reset-password' : '/verify-email';
    return `${base}${path}?token=${encodeURIComponent(token)}`;
  }

  /**
   * Validate and consume, or throw.
   *
   * Unknown, already-consumed and wrong-purpose all raise the same error. A
   * token presented for the wrong purpose is especially worth collapsing: if a
   * verification token could be distinguished from a reset token, someone
   * holding the weaker one would learn that the stronger one exists.
   */
  private async consumeToken(token: string, purpose: UserTokenPurpose) {
    const record = await this.tokens.findByTokenHash(this.hashes.hash(token));

    if (!record || record.purpose !== purpose || record.consumedAt) {
      throw new AccountTokenInvalidError();
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      throw new AccountTokenExpiredError();
    }

    if (record.userAccount.deletedAt || record.userAccount.status === 'DISABLED') {
      throw new AccountTokenInvalidError();
    }

    // Compare-and-swap. A losing racer sees count 0 and is refused, so two
    // concurrent uses of one link cannot both succeed.
    if (!(await this.tokens.consume(record.id))) {
      throw new AccountTokenInvalidError();
    }

    return { userAccountId: record.userAccountId, email: record.userAccount.email };
  }
}
