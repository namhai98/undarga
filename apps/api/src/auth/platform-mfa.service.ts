import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ConflictError, ValidationFailedError } from '../common/errors';
import { SecretBox } from '../common/crypto/secret-box';
import { AppConfig } from '../config';
import { IdentityRepository } from './identity.repository';
import { generateTotpSecret, matchTotp, otpauthUri } from './totp';

const ISSUER = 'Undarga Platform';

/**
 * Second factor for platform operators — the accounts that can reach every
 * company.
 *
 * The TOTP secret is sealed with SECRETS_ENCRYPTION_KEY (AES-256-GCM, bound to
 * the operator's id) and never leaves this service except once, at setup, so
 * the operator can add it to an authenticator app. Every accepted code spends
 * its time step: a code cannot be used twice.
 */
@Injectable()
export class PlatformMfaService {
  private readonly logger = new Logger(PlatformMfaService.name);
  private readonly box: SecretBox;

  constructor(
    private readonly identity: IdentityRepository,
    private readonly audit: AuditService,
    config: AppConfig,
  ) {
    this.box = new SecretBox(config.auth.secretsKey);
  }

  async status(platformUserId: string) {
    const row = await this.identity.findPlatformMfa(platformUserId);
    return { enrolled: Boolean(row?.mfaEnrolledAt), available: this.box.available };
  }

  /** Start (or restart) enrolment. The secret is returned this once. */
  async setup(platformUserId: string) {
    const row = await this.identity.findPlatformMfa(platformUserId);
    if (!row) throw new ConflictError('Unknown operator.');
    if (row.mfaEnrolledAt) {
      throw new ConflictError('Two-factor authentication is already set up for this account.');
    }
    if (!this.box.available) {
      throw new ConflictError(
        'Two-factor authentication cannot be set up: SECRETS_ENCRYPTION_KEY is not configured.',
      );
    }
    const secret = generateTotpSecret();
    const stored = await this.identity.setPendingPlatformMfa(
      platformUserId,
      this.box.seal(secret, context(platformUserId)),
    );
    if (!stored) throw new ConflictError('Two-factor authentication is already set up.');
    return { secret, otpauthUri: otpauthUri(ISSUER, row.email, secret) };
  }

  /** Finish enrolment with a code from the app, proving it holds the secret. */
  async confirm(platformUserId: string, code: string) {
    const row = await this.identity.findPlatformMfa(platformUserId);
    if (!row?.mfaSecret || row.mfaEnrolledAt) {
      throw new ConflictError('Start the setup first.');
    }
    const step = matchTotp(this.open(row.id, row.mfaSecret), code);
    if (step === null) {
      throw new ValidationFailedError({
        code: 'That code is not right. Check the time on your phone and try again.',
      });
    }
    if (!(await this.identity.confirmPlatformMfa(platformUserId, step))) {
      throw new ConflictError('Two-factor authentication is already set up.');
    }
    await this.audit.record({
      action: 'platform.mfa_enrolled',
      resourceType: 'platform_user',
      resourceId: platformUserId,
      platformLevel: true,
    });
    return { enrolled: true };
  }

  /** At sign-in: is this the right code, presented for the first time? */
  async verify(user: { id: string; mfaSecret: string | null }, code: string): Promise<boolean> {
    if (!user.mfaSecret) return false;
    let secret: string;
    try {
      secret = this.open(user.id, user.mfaSecret);
    } catch {
      // A rotated key or a tampered row: fail closed, and say why in the log.
      this.logger.error(`Cannot open the MFA secret of platform user ${user.id}.`);
      return false;
    }
    const step = matchTotp(secret, code);
    if (step === null) return false;
    return this.identity.claimPlatformMfaStep(user.id, step);
  }

  private open(platformUserId: string, sealed: string): string {
    return this.box.open(sealed, context(platformUserId));
  }
}

function context(platformUserId: string): string {
  return `platform-mfa:${platformUserId}`;
}
