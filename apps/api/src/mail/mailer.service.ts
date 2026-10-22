import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config';
import { SendGridEmailProvider } from '../notifications/providers/sendgrid.provider';

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
 * With `EMAIL_PROVIDER=sendgrid` these go through the platform's SendGrid
 * account — the same adapter the notification worker uses. Otherwise there is
 * no transport, and rather than pretend, development writes the link to the
 * log at warn level so a developer can complete the flow locally.
 *
 * These are sent inline, not through the notification queue: a sign-in code
 * that arrives ten minutes later is useless, and the token must never sit in
 * a notification row.
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

  private readonly sendgrid: SendGridEmailProvider | null;

  constructor(private readonly config: AppConfig) {
    const email = config.notificationProviders.email;
    this.sendgrid =
      email.provider === 'sendgrid' && email.sendgridApiKey && email.fromAddress
        ? new SendGridEmailProvider({
            apiKey: email.sendgridApiKey,
            fromAddress: email.fromAddress,
            fromName: email.fromName,
          })
        : null;
  }

  /** True once a transport is configured (SMTP is a placeholder; SendGrid is real). */
  get isConfigured(): boolean {
    return this.sendgrid !== null || this.config.email.configured;
  }

  async sendAccountLink(email: AccountLinkEmail): Promise<void> {
    if (this.sendgrid) {
      const verb =
        email.kind === 'email-verification' ? 'Confirm your email address' : 'Reset your password';
      await this.viaSendGrid(
        email.kind,
        email.to,
        verb,
        `${verb} with this link:\n\n${email.link}\n\nIt expires at ${email.expiresAt.toISOString()}. If you did not ask for this, ignore this email.`,
      );
      return;
    }
    if (this.config.email.configured) {
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

  /**
   * The customer portal's sign-in code. Same delivery rules as account links:
   * no transport yet, so development logs it and production says it could not.
   */
  async sendCustomerSignInCode(email: CustomerSignInCodeEmail): Promise<void> {
    await this.deliver(
      `customer sign-in code for ${email.companyName}`,
      email.to,
      `${email.code} (expires ${email.expiresAt.toISOString()})`,
    );
  }

  /** Shared delivery for short transactional messages (see `sendAccountLink`). */
  async deliver(kind: string, to: string, body: string): Promise<void> {
    if (this.sendgrid) {
      await this.viaSendGrid(kind, to, capitalise(kind), body);
      return;
    }
    if (this.config.email.configured) {
      throw new Error(
        'SMTP is configured but no transport is implemented yet. ' +
          'Unset SMTP_HOST, or implement MailerService.deliver.',
      );
    }
    if (this.config.app.isProduction) {
      this.logger.error(
        `Cannot send ${kind} to ${redactEmail(to)}: no mail transport is configured.`,
      );
      return;
    }
    this.logger.warn(`[dev] ${kind} for ${to}\n      ${body}`);
  }

  /**
   * Never throws: the flows calling this are enumeration-resistant, and an
   * error here would tell a caller whether the address exists. The failure is
   * logged with the address redacted and never the body (it holds the token).
   */
  private async viaSendGrid(kind: string, to: string, subject: string, body: string) {
    const result = await this.sendgrid!.send({
      channel: 'EMAIL',
      to,
      subject,
      body,
      notificationId: randomUUID(),
    });
    if (result.status === 'FAILED' || result.status === 'UNKNOWN') {
      this.logger.error(
        `Could not send ${kind} to ${redactEmail(to)}: ${result.status.toLowerCase()} — ${result.failureReason ?? 'no reason given'}`,
      );
    }
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `a***@example.com` — enough to identify the account, not to harvest it. */
export interface CustomerSignInCodeEmail {
  to: string;
  companyName: string;
  code: string;
  expiresAt: Date;
}

function redactEmail(value: string): string {
  const [local = '', domain = ''] = value.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
