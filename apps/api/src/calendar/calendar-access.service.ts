import { Injectable, Logger } from '@nestjs/common';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { CalendarProviderRegistry } from './calendar-provider.registry';
import { CalendarProviderError, type CalendarProvider } from './providers/calendar-provider';

/** What a provider call needs to know about a connection. */
export interface ConnectionRef {
  id: string;
  companyId: string;
  employeeId: string;
  provider: string;
  credentials: string;
  accessTokenExpiresAt: Date | null;
}

/** Refresh this long before the provider says the token expires. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Calls a provider on behalf of one connection, with a valid access token.
 *
 *   - Refreshes ahead of expiry, and once more if the provider still answers
 *     401 (a token revoked early, or a clock disagreement).
 *   - A refused refresh (`invalid_grant`) means the user revoked access or the
 *     grant expired: the connection becomes NEEDS_REAUTH and stops syncing
 *     until someone reconnects it. No retries against a dead grant.
 *   - New tokens are re-sealed and stored. Tokens never leave this class
 *     except as the argument to the provider call.
 */
@Injectable()
export class CalendarAccessService {
  private readonly logger = new Logger(CalendarAccessService.name);

  constructor(
    private readonly db: TenantPrismaService,
    private readonly registry: CalendarProviderRegistry,
  ) {}

  async withToken<T>(
    connection: ConnectionRef,
    fn: (provider: CalendarProvider, accessToken: string) => Promise<T>,
  ): Promise<T> {
    const provider = this.registry.get(connection.provider);
    if (!provider) {
      throw new CalendarProviderError(
        'PERMANENT',
        `${connection.provider} is not configured on this server.`,
      );
    }

    let tokens;
    try {
      tokens = this.registry.open(
        connection.companyId,
        connection.employeeId,
        connection.credentials,
      );
    } catch {
      await this.needsReauth(
        connection,
        'Stored credentials could not be decrypted. Reconnect the calendar.',
      );
      throw new CalendarProviderError('AUTH', 'Stored credentials could not be decrypted.');
    }

    const expiring =
      connection.accessTokenExpiresAt !== null &&
      connection.accessTokenExpiresAt.getTime() - Date.now() < EXPIRY_MARGIN_MS;
    let accessToken = expiring
      ? await this.refresh(connection, provider, tokens)
      : tokens.accessToken;

    try {
      return await fn(provider, accessToken);
    } catch (error) {
      if (!(error instanceof CalendarProviderError) || error.kind !== 'AUTH') throw error;
      // One refresh and one retry; a second 401 is the grant's answer.
      accessToken = await this.refresh(connection, provider, tokens);
      try {
        return await fn(provider, accessToken);
      } catch (again) {
        if (again instanceof CalendarProviderError && again.kind === 'AUTH') {
          await this.needsReauth(connection, 'The calendar refused access. Reconnect it.');
        }
        throw again;
      }
    }
  }

  private async refresh(
    connection: ConnectionRef,
    provider: CalendarProvider,
    tokens: { accessToken: string; refreshToken: string | null },
  ): Promise<string> {
    if (!tokens.refreshToken) {
      await this.needsReauth(connection, 'The calendar access expired. Reconnect it.');
      throw new CalendarProviderError('AUTH', 'No refresh token.');
    }
    try {
      const next = await provider.refresh(tokens.refreshToken);
      const merged = CalendarProviderRegistry.merge(tokens, next);
      const sealed = this.registry.seal(connection.companyId, connection.employeeId, merged);
      await this.db.runInCompany(connection.companyId, (tx) =>
        tx.calendarConnection.updateMany({
          where: { id: connection.id, companyId: connection.companyId },
          data: { credentials: sealed, accessTokenExpiresAt: next.expiresAt },
        }),
      );
      // Later calls in this run use the new values.
      connection.credentials = sealed;
      connection.accessTokenExpiresAt = next.expiresAt;
      tokens.accessToken = merged.accessToken;
      tokens.refreshToken = merged.refreshToken;
      return merged.accessToken;
    } catch (error) {
      if (error instanceof CalendarProviderError && error.kind === 'AUTH') {
        await this.needsReauth(
          connection,
          'The calendar access was revoked or expired. Reconnect it.',
        );
      }
      throw error;
    }
  }

  async needsReauth(
    connection: Pick<ConnectionRef, 'id' | 'companyId'>,
    reason: string,
  ): Promise<void> {
    this.logger.warn(`Calendar connection ${connection.id} needs reauthorisation.`);
    await this.db.runInCompany(connection.companyId, (tx) =>
      tx.calendarConnection.updateMany({
        where: { id: connection.id, companyId: connection.companyId },
        data: { status: 'NEEDS_REAUTH', lastError: reason.slice(0, 512), lastErrorAt: new Date() },
      }),
    );
  }
}
