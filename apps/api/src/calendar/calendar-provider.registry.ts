import { Injectable } from '@nestjs/common';
import { SecretBox } from '../common/crypto/secret-box';
import { AppConfig } from '../config';
import {
  CALENDAR_PROVIDER_NAMES,
  type CalendarProvider,
  type CalendarProviderName,
  type OAuthTokens,
} from './providers/calendar-provider';
import { GoogleCalendarProvider } from './providers/google-calendar.provider';
import { MicrosoftCalendarProvider } from './providers/microsoft-calendar.provider';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
}

/**
 * The calendar providers this server can use: a provider exists only when its
 * OAuth client id and secret are configured. Nothing is faked — an
 * unconfigured provider cannot be connected.
 *
 * Also the one place tokens are sealed and opened (AES-256-GCM via
 * SECRETS_ENCRYPTION_KEY, bound to company + employee), so a sealed value
 * copied to another row does not decrypt.
 */
@Injectable()
export class CalendarProviderRegistry {
  private readonly providers = new Map<CalendarProviderName, CalendarProvider>();
  private readonly box: SecretBox;

  constructor(private readonly config: AppConfig) {
    const settings = config.calendar;
    if (settings.google) this.providers.set('google', new GoogleCalendarProvider(settings.google));
    if (settings.microsoft) {
      this.providers.set(
        'microsoft',
        new MicrosoftCalendarProvider({ ...settings.microsoft, tenant: settings.microsoftTenant }),
      );
    }
    this.box = new SecretBox(config.notificationProviders.secretsKey);
  }

  get encryptionAvailable(): boolean {
    return this.box.available;
  }

  get redirectUrl(): string | null {
    return this.config.calendar.redirectUrl;
  }

  /** Configured, with an encryption key to store its tokens, and a redirect URL. */
  isUsable(name: CalendarProviderName): boolean {
    return this.providers.has(name) && this.box.available && !!this.redirectUrl;
  }

  get(name: string): CalendarProvider | null {
    return this.providers.get(name as CalendarProviderName) ?? null;
  }

  /** Every provider the product knows, and whether this server can use it. */
  catalog() {
    return CALENDAR_PROVIDER_NAMES.map((name) => ({
      provider: name,
      label: name === 'google' ? 'Google Calendar' : 'Microsoft Outlook',
      configured: this.isUsable(name),
      scopes: this.providers.get(name)?.scopes ?? [],
    }));
  }

  seal(companyId: string, employeeId: string, tokens: StoredTokens): string {
    return this.box.seal(JSON.stringify(tokens), tokenContext(companyId, employeeId));
  }

  /** @throws when the key changed or the value was moved or tampered with. */
  open(companyId: string, employeeId: string, sealed: string): StoredTokens {
    return JSON.parse(this.box.open(sealed, tokenContext(companyId, employeeId))) as StoredTokens;
  }

  sealVerifier(companyId: string, verifier: string): string {
    return this.box.seal(verifier, `calendar-oauth:${companyId}`);
  }

  openVerifier(companyId: string, sealed: string): string {
    return this.box.open(sealed, `calendar-oauth:${companyId}`);
  }

  /** Merge a refresh answer: a provider that sends no new refresh token keeps the old one. */
  static merge(current: StoredTokens, next: OAuthTokens): StoredTokens {
    return {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? current.refreshToken,
    };
  }
}

function tokenContext(companyId: string, employeeId: string): string {
  return `calendar-connection:${companyId}:${employeeId}`;
}
