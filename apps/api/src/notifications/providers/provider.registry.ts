import { Inject, Injectable } from '@nestjs/common';
import type { NotificationChannel, Prisma } from '@prisma/client';
import { SecretBox } from '../../common/crypto/secret-box';
import { AppConfig } from '../../config';
import { isValidAddress } from './address-rules';
import { NOTIFICATION_PROVIDERS, type NotificationProvider } from './notification-provider';
import { SendGridEmailProvider } from './sendgrid.provider';
import { TwilioSmsProvider } from './twilio.provider';

/** Which providers a company may configure itself, per channel. */
export const COMPANY_PROVIDERS = {
  EMAIL: ['sendgrid'],
  SMS: ['twilio'],
} as const;
export type CompanyProviderChannel = keyof typeof COMPANY_PROVIDERS;

export interface ProviderConfigRow {
  id: string;
  companyId: string;
  channel: NotificationChannel;
  provider: string;
  credentials: string;
  settings: Prisma.JsonValue;
  updatedAt: Date;
}

/**
 * Channel → who sends.
 *
 *   platform    one provider per channel from the environment (EMAIL_PROVIDER,
 *               SMS_PROVIDER, PUSH_PROVIDER). `none` registers nothing.
 *   company     a company's own account (`notification_provider_config`),
 *               decrypted here and only here, and cached until it changes.
 *
 * Address validation does not depend on either: whether an address is
 * well-formed is the same question whether or not a provider is configured.
 */
@Injectable()
export class NotificationProviderRegistry {
  private readonly platform = new Map<NotificationChannel, NotificationProvider>();
  private readonly companyCache = new Map<
    string,
    { version: number; provider: NotificationProvider }
  >();
  readonly secrets: SecretBox;

  constructor(
    @Inject(NOTIFICATION_PROVIDERS) providers: readonly NotificationProvider[],
    config: AppConfig,
  ) {
    for (const provider of providers) {
      for (const channel of provider.channels) this.platform.set(channel, provider);
    }
    this.secrets = new SecretBox(config.notificationProviders.secretsKey);
  }

  /** The platform's provider for a channel, or null when it is `none`. */
  forChannel(channel: NotificationChannel): NotificationProvider | null {
    return this.platform.get(channel) ?? null;
  }

  isValidAddress(channel: NotificationChannel, address: string): boolean {
    return isValidAddress(channel, address);
  }

  /**
   * A company's own provider, built from its stored configuration.
   * @throws when the credentials cannot be decrypted (wrong or rotated key).
   */
  forCompanyConfig(row: ProviderConfigRow): NotificationProvider {
    const cached = this.companyCache.get(row.id);
    if (cached && cached.version === row.updatedAt.getTime()) return cached.provider;
    const provider = this.build(
      row.channel,
      row.provider,
      this.openSecrets(row),
      settingsOf(row.settings),
    );
    this.companyCache.set(row.id, { version: row.updatedAt.getTime(), provider });
    return provider;
  }

  /** Decrypted secrets of a stored configuration. Never leaves the API. */
  openSecrets(
    row: Pick<ProviderConfigRow, 'companyId' | 'channel' | 'credentials'>,
  ): Record<string, string> {
    return JSON.parse(
      this.secrets.open(row.credentials, secretContext(row.companyId, row.channel)),
    ) as Record<string, string>;
  }

  sealSecrets(
    companyId: string,
    channel: NotificationChannel,
    secrets: Record<string, string>,
  ): string {
    return this.secrets.seal(JSON.stringify(secrets), secretContext(companyId, channel));
  }

  /** An adapter from a provider name, secrets and non-secret settings. */
  build(
    channel: NotificationChannel,
    provider: string,
    secrets: Record<string, string>,
    settings: Record<string, string>,
  ): NotificationProvider {
    if (channel === 'EMAIL' && provider === 'sendgrid') {
      return new SendGridEmailProvider({
        apiKey: secrets.apiKey ?? '',
        fromAddress: settings.fromAddress ?? '',
        fromName: settings.fromName ?? null,
      });
    }
    if (channel === 'SMS' && provider === 'twilio') {
      return new TwilioSmsProvider({
        accountSid: settings.accountSid ?? '',
        authToken: secrets.authToken ?? '',
        fromNumber: settings.fromNumber ?? null,
        messagingServiceSid: settings.messagingServiceSid ?? null,
      });
    }
    throw new Error(`Unsupported provider ${provider} for ${channel}.`);
  }
}

export function secretContext(companyId: string, channel: NotificationChannel): string {
  return `notification-provider:${companyId}:${channel}`;
}

export function settingsOf(value: Prisma.JsonValue): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
