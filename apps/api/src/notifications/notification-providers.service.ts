import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import {
  NotificationProvidersUnavailableError,
  ResourceNotFoundError,
  ValidationFailedError,
} from '../common/errors';
import { AppConfig } from '../config';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';
import type { ProviderChannel, SaveProviderConfigDto } from './dto/notification-provider.dto';
import { DELIVERY_CHANNELS, type DeliveryChannel } from './notification-templates';
import {
  NotificationProviderRegistry,
  COMPANY_PROVIDERS,
  settingsOf,
} from './providers/provider.registry';
import { sendGridPublicKey } from './providers/sendgrid.provider';

interface ConfigRow {
  id: string;
  companyId: string;
}

@Injectable()
export class NotificationProviderConfigRepository extends TenantScopedRepository<ConfigRow> {
  protected readonly modelName = 'NotificationProviderConfig';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<ConfigRow> {
    return tx.notificationProviderConfig;
  }
}

const CONFIG_SELECT = {
  id: true,
  companyId: true,
  channel: true,
  provider: true,
  isEnabled: true,
  credentials: true,
  secretHint: true,
  settings: true,
  status: true,
  lastCheckedAt: true,
  lastError: true,
  updatedAt: true,
} as const satisfies Prisma.NotificationProviderConfigSelect;

type StoredConfig = Prisma.NotificationProviderConfigGetPayload<{ select: typeof CONFIG_SELECT }>;

/**
 * Who sends a company's notifications, per channel.
 *
 *   platform  the SaaS's own account (environment variables). The default.
 *   company   the company's own SendGrid / Twilio account, stored here with
 *             its secret encrypted (SECRETS_ENCRYPTION_KEY, AES-256-GCM).
 *
 * Secrets are write-only: a response carries the last four characters
 * (`secretHint`) and nothing else, and audit entries record that a secret
 * changed, never its value.
 */
@Injectable()
export class NotificationProvidersService {
  constructor(
    private readonly configs: NotificationProviderConfigRepository,
    private readonly registry: NotificationProviderRegistry,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.configs.transaction((tx, companyId) =>
      tx.notificationProviderConfig.findMany({ where: { companyId }, select: CONFIG_SELECT }),
    );
    return {
      /** False when SECRETS_ENCRYPTION_KEY is not set: company accounts cannot be saved. */
      companyAccountsAvailable: this.registry.secrets.available,
      channels: DELIVERY_CHANNELS.map((channel) =>
        this.view(channel, rows.find((row) => row.channel === channel) ?? null),
      ),
    };
  }

  async save(channel: ProviderChannel, dto: SaveProviderConfigDto) {
    if (!this.registry.secrets.available) throw new NotificationProvidersUnavailableError();
    if (!(COMPANY_PROVIDERS[channel] as readonly string[]).includes(dto.provider)) {
      throw new ValidationFailedError([
        { path: ['provider'], message: `${dto.provider} cannot send ${channel}.` },
      ]);
    }
    if (dto.provider === 'sendgrid' && dto.settings.webhookPublicKey) {
      try {
        sendGridPublicKey(dto.settings.webhookPublicKey);
      } catch {
        throw new ValidationFailedError([
          { path: ['settings', 'webhookPublicKey'], message: 'Not a valid verification key.' },
        ]);
      }
    }
    const secret = dto.provider === 'sendgrid' ? dto.secrets?.apiKey : dto.secrets?.authToken;
    const secrets = dto.secrets as Record<string, string> | undefined;

    const saved = await this.configs.transaction(async (tx, companyId) => {
      const existing = await tx.notificationProviderConfig.findFirst({
        where: { companyId, channel },
        select: CONFIG_SELECT,
      });
      // A new account, or a different provider, needs its secret; an edit of
      // the same one may keep the stored secret.
      if (!secrets && (!existing || existing.provider !== dto.provider)) {
        throw new ValidationFailedError([
          { path: ['secrets'], message: 'The provider’s secret is required.' },
        ]);
      }
      const data = {
        provider: dto.provider,
        isEnabled: dto.isEnabled,
        settings: dto.settings as Prisma.InputJsonValue,
        status: 'UNVERIFIED',
        lastError: null,
        lastCheckedAt: null,
        ...(secrets && secret
          ? {
              credentials: this.registry.sealSecrets(companyId, channel, secrets),
              secretHint: secret.slice(-4),
            }
          : {}),
      };
      if (existing) {
        await tx.notificationProviderConfig.updateMany({
          where: { id: existing.id, companyId },
          data,
        });
      } else {
        await tx.notificationProviderConfig.create({
          data: {
            ...data,
            companyId,
            channel,
            credentials: data.credentials!,
            secretHint: data.secretHint!,
          },
        });
      }
      const row = await tx.notificationProviderConfig.findFirstOrThrow({
        where: { companyId, channel },
        select: CONFIG_SELECT,
      });
      return { row, before: existing };
    });

    await this.audit.record({
      action: saved.before ? 'notification_provider.updated' : 'notification_provider.configured',
      resourceType: 'NotificationProviderConfig',
      resourceId: saved.row.id,
      before: saved.before ? auditable(saved.before) : undefined,
      after: { ...auditable(saved.row), storedKeyReplaced: !!secrets },
    });
    return this.view(channel, saved.row);
  }

  async remove(channel: ProviderChannel) {
    const removed = await this.configs.transaction(async (tx, companyId) => {
      const existing = await tx.notificationProviderConfig.findFirst({
        where: { companyId, channel },
        select: CONFIG_SELECT,
      });
      if (!existing) throw new ResourceNotFoundError('NotificationProviderConfig', channel);
      await tx.notificationProviderConfig.deleteMany({ where: { id: existing.id, companyId } });
      return existing;
    });
    await this.audit.record({
      action: 'notification_provider.removed',
      resourceType: 'NotificationProviderConfig',
      resourceId: removed.id,
      before: auditable(removed),
    });
    return this.view(channel, null);
  }

  /**
   * Ask the provider whether the stored credentials work. The network call
   * happens outside any transaction; only the result is written.
   */
  async verify(channel: ProviderChannel) {
    const row = await this.configs.transaction((tx, companyId) =>
      tx.notificationProviderConfig.findFirst({
        where: { companyId, channel },
        select: CONFIG_SELECT,
      }),
    );
    if (!row) throw new ResourceNotFoundError('NotificationProviderConfig', channel);

    let result: { ok: boolean; error?: string };
    try {
      const provider = this.registry.build(
        row.channel,
        row.provider,
        this.registry.openSecrets(row),
        settingsOf(row.settings),
      );
      result = provider.verify
        ? await provider.verify()
        : { ok: false, error: 'This provider cannot be checked.' };
    } catch {
      result = { ok: false, error: 'The stored credentials could not be read. Save them again.' };
    }

    const updated = await this.configs.transaction(async (tx, companyId) => {
      await tx.notificationProviderConfig.updateMany({
        where: { id: row.id, companyId },
        data: {
          status: result.ok ? 'CONNECTED' : 'FAILED',
          lastError: result.ok ? null : (result.error ?? 'Verification failed.').slice(0, 512),
          lastCheckedAt: new Date(),
        },
      });
      return tx.notificationProviderConfig.findFirstOrThrow({
        where: { id: row.id, companyId },
        select: CONFIG_SELECT,
      });
    });
    await this.audit.record({
      action: 'notification_provider.verified',
      resourceType: 'NotificationProviderConfig',
      resourceId: row.id,
      after: { channel, status: updated.status },
    });
    return this.view(channel, updated);
  }

  /** The platform's own providers, for operators. Names and readiness only. */
  platformStatus() {
    const settings = this.config.notificationProviders;
    const receipts = !!settings.webhookBaseUrl;
    return {
      secretsEncryptionConfigured: this.registry.secrets.available,
      receiptBaseUrlConfigured: receipts,
      channels: DELIVERY_CHANNELS.map((channel) => {
        const provider = this.registry.forChannel(channel)?.name ?? null;
        return {
          channel,
          provider,
          configured: provider !== null,
          receipts:
            (channel === 'EMAIL' &&
              settings.email.provider === 'sendgrid' &&
              !!settings.email.sendgridWebhookPublicKey) ||
            (channel === 'SMS' && settings.sms.provider === 'twilio' && receipts),
        };
      }),
    };
  }

  private view(channel: DeliveryChannel, row: StoredConfig | null) {
    const platform = this.registry.forChannel(channel)?.name ?? null;
    const company = row
      ? {
          id: row.id,
          provider: row.provider,
          isEnabled: row.isEnabled,
          status: row.status,
          lastCheckedAt: row.lastCheckedAt,
          lastError: row.lastError,
          /** Masked: the last four characters of the stored secret. */
          secretHint: `••••${row.secretHint}`,
          settings: settingsOf(row.settings),
          receiptUrl: this.receiptUrl(row.provider, row.id),
          updatedAt: row.updatedAt,
        }
      : null;
    return {
      channel,
      active: company?.isEnabled ? 'company' : platform ? 'platform' : 'none',
      platformProvider: platform,
      supportedProviders: channel === 'PUSH' ? [] : [...COMPANY_PROVIDERS[channel]],
      company,
    };
  }

  /** The URL to paste into the provider's webhook settings (SendGrid); Twilio is told per message. */
  private receiptUrl(provider: string, configId: string): string | null {
    const base = this.config.notificationProviders.webhookBaseUrl;
    if (!base) return null;
    return `${base}/${this.config.app.apiPrefix}/v1/notifications/receipts/${provider}/${configId}`;
  }
}

/** A configuration as the audit log may see it: no credentials, no hint. */
function auditable(row: StoredConfig) {
  return {
    channel: row.channel,
    provider: row.provider,
    isEnabled: row.isEnabled,
    settings: settingsOf(row.settings),
  };
}
