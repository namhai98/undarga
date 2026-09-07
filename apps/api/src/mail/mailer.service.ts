import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config';

export interface AccountLinkEmail {
  to: string;
  /** Verification and reset differ only in the copy and the path. */
  kind: 'email-verification' | 'password-reset';
  /** The full URL the recipient clicks. Built from WEB_APP_URL, never Host. */
  link: string;
  expiresAt: Date;
}

/**
 * Outbound email.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND IS NOT
 * ---------------------------------------------------------------------------
 *
 * There is no mail transport in this system yet. Rather than pretend, this is
 * the seam where one will go: the flows that need to send mail call it, and
 * today it writes the link to the log at warn level so a developer can complete
 * the flow locally.
 *
 * That is a deliberate choice over the alternative of blocking password reset
 * and email verification entirely until phase 6. The security-critical parts —
 * token generation, hashing, expiry, single use, enumeration resistance — are
 * real and tested now. Delivery is the one piece that is stubbed, and it is the
 * piece with no security properties of its own.
 *
 * When SMTP or the notification outbox lands, this class gains a real
 * implementation and no caller changes.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LINK IS LOGGED IN DEVELOPMENT AND NEVER IN PRODUCTION
 * ---------------------------------------------------------------------------
 *
 * A reset link is a credential: whoever holds it can take over the account.
 * Logging one in production would put account takeover into whatever aggregates
 * the logs, readable by anyone with dashboard access and retained for months.
 *
 * So in production this logs only that mail WOULD have been sent, to whom, and
 * that no transport exists — which is the operational fact worth alerting on —
 * and never the link itself. If that path is ever hit in production it means
 * somebody shipped without configuring mail, and the log should say exactly
 * that rather than quietly leaking tokens.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);

  constructor(private readonly config: AppConfig) {}

  /** True once a transport is configured. Currently always false. */
  get isConfigured(): boolean {
    return this.config.email.configured;
  }

  async sendAccountLink(email: AccountLinkEmail): Promise<void> {
    if (this.isConfigured) {
      // Deliberately not implemented rather than half-implemented. A silent
      // no-op here would look like a delivery failure and be chased for hours.
      throw new Error(
        'SMTP is configured but no transport is implemented yet. ' +
          'Unset SMTP_HOST, or implement MailerService.sendAccountLink.',
      );
    }

    if (this.config.app.isProduction) {
      this.logger.error(
        `Cannot send ${email.kind} to ${redactEmail(email.to)}: no mail transport is ` +
          'configured. The user will not receive their link.',
      );
      return;
    }

    // Development only. See the class comment for why this is conditional.
    this.logger.warn(
      `[dev] ${email.kind} for ${email.to}\n` +
        `      ${email.link}\n` +
        `      expires ${email.expiresAt.toISOString()}`,
    );
  }
}

/** `a***@example.com` — enough to identify the account, not to harvest it. */
function redactEmail(value: string): string {
  const [local = '', domain = ''] = value.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
