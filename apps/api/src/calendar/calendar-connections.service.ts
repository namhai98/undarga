import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import {
  CalendarOAuthInvalidError,
  CalendarProviderFailedError,
  CalendarProviderUnavailableError,
  ConflictError,
  PermissionDeniedError,
  ResourceNotFoundError,
} from '../common/errors';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { CalendarAccessService } from './calendar-access.service';
import { CalendarProviderRegistry } from './calendar-provider.registry';
import { enqueueEmployeeBackfill } from './calendar-sync.queue';
import { CalendarSyncService } from './calendar-sync.service';
import type { UpdateConnectionDto } from './dto/calendar.dto';
import { CalendarProviderError, type CalendarProviderName } from './providers/calendar-provider';

const STATE_TTL_MS = 10 * 60_000;
/** On disconnect, at most this many upcoming events are removed (in the request). */
const DISCONNECT_CLEANUP_LIMIT = 100;

interface ConnectionRow {
  id: string;
  companyId: string;
}

@Injectable()
export class CalendarConnectionRepository extends TenantScopedRepository<ConnectionRow> {
  protected readonly modelName = 'CalendarConnection';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<ConnectionRow> {
    return tx.calendarConnection;
  }
}

type StoredConnection = NonNullable<
  Awaited<ReturnType<TenantTx['calendarConnection']['findFirst']>>
>;

/**
 * Connecting, inspecting and disconnecting employees' calendars.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY DO WHAT
 * ---------------------------------------------------------------------------
 *
 *   schedule:write:any   any employee's calendar (owners, admins, managers)
 *   schedule:write:own   only the employee linked to your own login
 *
 * Listing needs `schedule:read`, and shows only the employees you may manage.
 * Tokens never appear in any response, log or audit entry.
 *
 * ---------------------------------------------------------------------------
 * OAUTH
 * ---------------------------------------------------------------------------
 *
 * Authorization code + PKCE (S256). `start` stores SHA-256(state) with the
 * sealed code verifier, the employee, and the user who started it, for ten
 * minutes. The provider sends the browser to the configured redirect URL (the
 * web app's /calendar/callback — never a URL from the request), which posts
 * code + state back here. `complete` accepts the state once, only from the
 * same user in the same company, before exchanging the code.
 */
@Injectable()
export class CalendarConnectionsService {
  constructor(
    private readonly connections: CalendarConnectionRepository,
    private readonly registry: CalendarProviderRegistry,
    private readonly access: CalendarAccessService,
    private readonly sync: CalendarSyncService,
    private readonly context: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // Reading
  // ===========================================================================

  /** Providers, plus every employee the caller may manage with their connection. */
  async overview() {
    const employees = await this.connections.transaction(async (tx, companyId) => {
      const scope = await this.scope(tx, companyId);
      const rows = await tx.employee.findMany({
        where: {
          companyId,
          deletedAt: null,
          status: 'ACTIVE',
          ...(scope.kind === 'own'
            ? { id: scope.employeeId ?? '00000000-0000-0000-0000-000000000000' }
            : {}),
        },
        orderBy: { displayName: 'asc' },
        select: { id: true, displayName: true, userAccountId: true, calendarConnection: true },
        take: 500,
      });
      const failures = await this.failureCounts(
        tx,
        companyId,
        rows.flatMap((r) => (r.calendarConnection ? [r.calendarConnection.id] : [])),
      );
      return rows.map((row) => ({
        employeeId: row.id,
        displayName: row.displayName,
        isSelf: scope.selfEmployeeId === row.id,
        connection: row.calendarConnection
          ? this.view(row.calendarConnection, failures.get(row.calendarConnection.id) ?? 0)
          : null,
      }));
    });

    return {
      syncDirection: 'one-way' as const,
      providers: this.registry.catalog(),
      encryptionAvailable: this.registry.encryptionAvailable,
      employees,
    };
  }

  /** Status, the latest errors, and what is queued for this connection's employee. */
  async syncStatus(connectionId: string) {
    return this.connections.transaction(async (tx, companyId) => {
      const connection = await this.manageable(tx, companyId, connectionId);
      const [errors, failures, jobs] = await Promise.all([
        tx.calendarEventLink.findMany({
          where: { companyId, connectionId, lastError: { not: null } },
          orderBy: { lastErrorAt: 'desc' },
          take: 20,
          select: { appointmentId: true, lastError: true, lastErrorAt: true },
        }),
        this.failureCounts(tx, companyId, [connectionId]),
        tx.calendarSyncJob.groupBy({
          by: ['status'],
          where: {
            companyId,
            status: { in: ['PENDING', 'RUNNING', 'FAILED'] },
            appointmentId: {
              in: (
                await tx.appointmentItem.findMany({
                  where: {
                    companyId,
                    employeeId: connection.employeeId,
                    endsAt: { gte: new Date(Date.now() - 86_400_000) },
                  },
                  select: { appointmentId: true },
                  take: 1000,
                })
              ).map((i) => i.appointmentId),
            },
          },
          _count: { _all: true },
        }),
      ]);
      const count = (status: string) => jobs.find((j) => j.status === status)?._count._all ?? 0;
      return {
        connection: this.view(connection, failures.get(connectionId) ?? 0),
        queue: { pending: count('PENDING') + count('RUNNING'), failed: count('FAILED') },
        recentErrors: errors.map((e) => ({
          appointmentId: e.appointmentId,
          error: e.lastError,
          at: e.lastErrorAt,
        })),
      };
    });
  }

  /** The calendars the connected account may write to. */
  async calendars(connectionId: string) {
    const connection = await this.connections.transaction((tx, companyId) =>
      this.manageable(tx, companyId, connectionId),
    );
    this.requireActive(connection);
    try {
      return await this.access.withToken(connection, (provider, token) =>
        provider.listCalendars(token),
      );
    } catch (error) {
      throw toApiError(error);
    }
  }

  // ===========================================================================
  // OAuth
  // ===========================================================================

  async start(input: { provider: CalendarProviderName; employeeId: string }) {
    const provider = this.registry.get(input.provider);
    if (!provider || !this.registry.isUsable(input.provider)) {
      throw new CalendarProviderUnavailableError(
        !this.registry.encryptionAvailable
          ? 'Calendar connections need SECRETS_ENCRYPTION_KEY on the server.'
          : undefined,
      );
    }
    const actor = this.companyUser();
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);

    await this.connections.transaction(async (tx, companyId) => {
      await this.manageableEmployee(tx, companyId, input.employeeId);
      const existing = await tx.calendarConnection.findFirst({
        where: { companyId, employeeId: input.employeeId },
        select: { provider: true },
      });
      if (existing && existing.provider !== input.provider) {
        throw new ConflictError(
          'Disconnect the current calendar before connecting a different provider.',
          {
            provider: existing.provider,
          },
        );
      }
      await tx.calendarOAuthState.deleteMany({
        where: { companyId, expiresAt: { lt: new Date() } },
      });
      await tx.calendarOAuthState.create({
        data: {
          companyId,
          employeeId: input.employeeId,
          provider: input.provider,
          userAccountId: actor.userAccountId,
          stateHash: sha256(state),
          codeVerifier: this.registry.sealVerifier(companyId, verifier),
          expiresAt,
        },
      });
    });

    return {
      authorizationUrl: provider.authorizationUrl({
        state,
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
        redirectUri: this.registry.redirectUrl!,
      }),
      expiresAt,
    };
  }

  async complete(input: { state: string; code: string }) {
    const actor = this.companyUser();
    // 1. The state: known, unexpired, unused, same company, same user. Consumed now.
    const pending = await this.connections.transaction(async (tx, companyId) => {
      const row = await tx.calendarOAuthState.findFirst({
        where: { companyId, stateHash: sha256(input.state) },
      });
      if (
        !row ||
        row.usedAt ||
        row.expiresAt < new Date() ||
        row.userAccountId !== actor.userAccountId
      ) {
        throw new CalendarOAuthInvalidError();
      }
      const consumed = await tx.calendarOAuthState.updateMany({
        where: { id: row.id, companyId, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) throw new CalendarOAuthInvalidError();
      // Permission may have been taken away in the last ten minutes.
      await this.manageableEmployee(tx, companyId, row.employeeId);
      return { ...row, verifier: this.registry.openVerifier(companyId, row.codeVerifier) };
    });

    const provider = this.registry.get(pending.provider);
    if (!provider || !this.registry.isUsable(pending.provider as CalendarProviderName)) {
      throw new CalendarProviderUnavailableError();
    }

    // 2. The code, exchanged outside any transaction.
    let tokens;
    try {
      tokens = await provider.exchangeCode({
        code: input.code,
        codeVerifier: pending.verifier,
        redirectUri: this.registry.redirectUrl!,
      });
    } catch (error) {
      if (
        error instanceof CalendarProviderError &&
        error.kind !== 'TRANSIENT' &&
        error.kind !== 'RATE_LIMIT'
      ) {
        throw new CalendarProviderFailedError(
          'The provider refused the authorisation. Start again.',
        );
      }
      throw new CalendarProviderFailedError();
    }
    if (!tokens.refreshToken) {
      throw new CalendarProviderFailedError(
        'The provider did not grant ongoing access. Start again and accept every requested permission.',
      );
    }
    const calendarScope = provider.scopes.find(
      (s) => /calendar/i.test(s) && !/calendarlist/i.test(s),
    );
    if (
      tokens.scope &&
      calendarScope &&
      !tokens.scope.split(' ').some((s) => s.toLowerCase() === calendarScope.toLowerCase())
    ) {
      throw new CalendarProviderFailedError(
        'Calendar access was not granted. Start again and allow it.',
      );
    }

    // 3. Store it, sealed, and queue the employee's upcoming appointments.
    const result = await this.connections.transaction(async (tx, companyId) => {
      const credentials = this.registry.seal(companyId, pending.employeeId, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
      const existing = await tx.calendarConnection.findFirst({
        where: { companyId, employeeId: pending.employeeId },
      });
      const common = {
        provider: pending.provider,
        status: 'ACTIVE',
        accountEmail: tokens.accountEmail,
        credentials,
        accessTokenExpiresAt: tokens.expiresAt,
        scopes: (tokens.scope ?? provider.scopes.join(' ')).slice(0, 512),
        lastError: null,
        lastErrorAt: null,
        busySyncedAt: null,
        connectedById: this.context.membership()?.companyUserId ?? null,
      };
      if (existing) {
        await tx.calendarConnection.updateMany({ where: { id: existing.id, companyId }, data: common });
      }
      const connection = existing
        ? await tx.calendarConnection.findFirstOrThrow({ where: { id: existing.id, companyId } })
        : await tx.calendarConnection.create({
            data: { ...common, companyId, employeeId: pending.employeeId },
          });
      await enqueueEmployeeBackfill(tx, companyId, pending.employeeId, connection.id);
      return { connection, reauthorized: !!existing };
    });

    // The primary calendar's name and zone, best effort.
    await this.describePrimary(result.connection);

    await this.audit.record({
      action: result.reauthorized ? 'calendar.reauthorized' : 'calendar.connected',
      resourceType: 'CalendarConnection',
      resourceId: result.connection.id,
      after: { employeeId: pending.employeeId, provider: pending.provider },
    });
    return this.syncStatus(result.connection.id);
  }

  // ===========================================================================
  // Changing
  // ===========================================================================

  async update(connectionId: string, dto: UpdateConnectionDto) {
    const connection = await this.connections.transaction((tx, companyId) =>
      this.manageable(tx, companyId, connectionId),
    );

    let calendar: { id: string; name: string; timeZone: string | null } | null = null;
    if (dto.calendarId && dto.calendarId !== connection.calendarId) {
      this.requireActive(connection);
      let calendars;
      try {
        calendars = await this.access.withToken(connection, (provider, token) =>
          provider.listCalendars(token),
        );
      } catch (error) {
        throw toApiError(error);
      }
      const found = calendars.find((c) => c.id === dto.calendarId);
      // Only a calendar the account may write to: never an id from the request alone.
      if (!found) throw new ResourceNotFoundError('Calendar', dto.calendarId);
      calendar = {
        id: found.primary ? 'primary' : found.id,
        name: found.name,
        timeZone: found.timeZone,
      };
    }

    await this.connections.transaction(async (tx, companyId) => {
      await tx.calendarConnection.updateMany({
        where: { id: connectionId, companyId },
        data: {
          ...(calendar
            ? {
                calendarId: calendar.id,
                calendarName: calendar.name,
                calendarTimeZone: calendar.timeZone,
                busySyncedAt: null,
              }
            : {}),
          ...(dto.syncCompleted !== undefined ? { syncCompleted: dto.syncCompleted } : {}),
          ...(dto.useForAvailability !== undefined
            ? { useForAvailability: dto.useForAvailability }
            : {}),
        },
      });
      if (dto.useForAvailability === false) {
        await tx.calendarBusyBlock.deleteMany({ where: { companyId, connectionId } });
      }
      if (dto.useForAvailability === true) {
        await tx.calendarConnection.updateMany({
          where: { id: connectionId, companyId },
          data: { busySyncedAt: null },
        });
      }
      if (calendar || dto.syncCompleted !== undefined) {
        // Events move to the new calendar / completed ones appear or go.
        await enqueueEmployeeBackfill(tx, companyId, connection.employeeId, connectionId);
      }
    });

    await this.audit.record({
      action: 'calendar.updated',
      resourceType: 'CalendarConnection',
      resourceId: connectionId,
      after: {
        ...(calendar ? { calendar: calendar.name } : {}),
        ...(dto.syncCompleted !== undefined ? { syncCompleted: dto.syncCompleted } : {}),
        ...(dto.useForAvailability !== undefined
          ? { useForAvailability: dto.useForAvailability }
          : {}),
      },
    });
    return this.syncStatus(connectionId);
  }

  /**
   * Disconnect: remove our upcoming events (best effort), revoke the grant at
   * the provider where it allows that, then delete the stored tokens, links
   * and busy periods. The local removal happens whatever the provider says.
   */
  async disconnect(connectionId: string) {
    const { connection, upcoming } = await this.connections.transaction(async (tx, companyId) => {
      const connection = await this.manageable(tx, companyId, connectionId);
      const links = await tx.calendarEventLink.findMany({
        where: { companyId, connectionId },
        select: { appointmentId: true, calendarId: true, externalEventId: true },
      });
      const live = new Set(
        (
          await tx.appointment.findMany({
            where: {
              companyId,
              id: { in: links.map((l) => l.appointmentId) },
              endsAt: { gte: new Date() },
            },
            select: { id: true },
          })
        ).map((a) => a.id),
      );
      return {
        connection,
        upcoming: links.filter((l) => live.has(l.appointmentId)).slice(0, DISCONNECT_CLEANUP_LIMIT),
      };
    });

    let removed = 0;
    if (connection.status === 'ACTIVE') {
      try {
        await this.access.withToken(connection, async (provider, token) => {
          for (const link of upcoming) {
            await provider.deleteEvent(token, link.calendarId, link.externalEventId).then(
              () => (removed += 1),
              () => undefined,
            );
          }
        });
      } catch {
        // Already unusable: the events stay; the tokens still go.
      }
    }
    try {
      const tokens = this.registry.open(
        connection.companyId,
        connection.employeeId,
        connection.credentials,
      );
      await this.registry.get(connection.provider)?.revoke(tokens);
    } catch {
      // Nothing usable to revoke.
    }

    await this.connections.transaction((tx, companyId) =>
      tx.calendarConnection.deleteMany({ where: { id: connectionId, companyId } }),
    );
    await this.audit.record({
      action: 'calendar.disconnected',
      resourceType: 'CalendarConnection',
      resourceId: connectionId,
      before: { employeeId: connection.employeeId, provider: connection.provider },
      after: { upcomingEventsRemoved: removed },
    });
    return { disconnected: true, upcomingEventsRemoved: removed };
  }

  /**
   * Sync this employee's calendar now: queue every upcoming appointment again
   * (failed ones included), re-read busy periods, and run the queue for this
   * company. Bounded, and the same work the background worker does.
   */
  async resync(connectionId: string) {
    const connection = await this.connections.transaction(async (tx, companyId) => {
      const connection = await this.manageable(tx, companyId, connectionId);
      this.requireActive(connection);
      const queued = await enqueueEmployeeBackfill(
        tx,
        companyId,
        connection.employeeId,
        connectionId,
      );
      await tx.calendarConnection.updateMany({
        where: { id: connectionId, companyId },
        data: { busySyncedAt: null },
      });
      return { ...connection, queued };
    });
    const events = await this.sync.processDue({ companyId: connection.companyId, limit: 50 });
    const busy = connection.useForAvailability
      ? await this.sync.refreshBusy({ companyId: connection.companyId, connectionId, limit: 1 })
      : { refreshed: 0, failed: 0 };
    await this.audit.record({
      action: 'calendar.resynced',
      resourceType: 'CalendarConnection',
      resourceId: connectionId,
      after: { queued: connection.queued },
    });
    return {
      queued: connection.queued,
      ...events,
      busyRefreshed: busy.refreshed > 0,
      ...(await this.syncStatus(connectionId)),
    };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private async describePrimary(connection: StoredConnection) {
    try {
      const calendars = await this.access.withToken(connection, (provider, token) =>
        provider.listCalendars(token),
      );
      const primary = calendars.find((c) => c.primary) ?? null;
      if (!primary) return;
      await this.connections.transaction((tx, companyId) =>
        tx.calendarConnection.updateMany({
          where: { id: connection.id, companyId, calendarId: 'primary' },
          data: { calendarName: primary.name.slice(0, 256), calendarTimeZone: primary.timeZone },
        }),
      );
    } catch {
      // The name is cosmetic; the connection works without it.
    }
  }

  private requireActive(connection: { status: string }) {
    if (connection.status !== 'ACTIVE') {
      throw new ConflictError('This calendar needs to be reconnected first.', {
        status: connection.status,
      });
    }
  }

  private companyUser() {
    const actor = this.context.requireActor();
    if (actor.kind !== 'COMPANY_USER')
      throw new PermissionDeniedError([COMPANY_PERMISSIONS.SCHEDULE_WRITE_OWN]);
    return actor;
  }

  /** `any`: every employee. `own`: only the employee linked to the caller's login. */
  private async scope(tx: TenantTx, companyId: string) {
    const actor = this.context.actor;
    const self =
      actor?.kind === 'COMPANY_USER'
        ? await tx.employee.findFirst({
            where: { companyId, userAccountId: actor.userAccountId, deletedAt: null },
            select: { id: true },
          })
        : null;
    if (this.context.hasPermission(COMPANY_PERMISSIONS.SCHEDULE_WRITE_ANY)) {
      return { kind: 'any' as const, selfEmployeeId: self?.id ?? null, employeeId: null };
    }
    const own = this.context.hasPermission(COMPANY_PERMISSIONS.SCHEDULE_WRITE_OWN)
      ? (self?.id ?? null)
      : null;
    return { kind: 'own' as const, selfEmployeeId: self?.id ?? null, employeeId: own };
  }

  private async manageableEmployee(tx: TenantTx, companyId: string, employeeId: string) {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, companyId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) throw new ResourceNotFoundError('Employee', employeeId);
    const scope = await this.scope(tx, companyId);
    if (scope.kind === 'own' && scope.employeeId !== employeeId) {
      throw new PermissionDeniedError([COMPANY_PERMISSIONS.SCHEDULE_WRITE_ANY]);
    }
    return employee;
  }

  private async manageable(tx: TenantTx, companyId: string, connectionId: string) {
    const connection = await tx.calendarConnection.findFirst({
      where: { id: connectionId, companyId },
    });
    if (!connection) throw new ResourceNotFoundError('CalendarConnection', connectionId);
    await this.manageableEmployee(tx, companyId, connection.employeeId);
    return connection;
  }

  private async failureCounts(tx: TenantTx, companyId: string, connectionIds: string[]) {
    if (connectionIds.length === 0) return new Map<string, number>();
    const rows = await tx.calendarEventLink.groupBy({
      by: ['connectionId'],
      where: { companyId, connectionId: { in: connectionIds }, lastError: { not: null } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.connectionId, r._count._all]));
  }

  /** A connection as the API shows it. No credentials, ever. */
  private view(connection: StoredConnection, failedEvents: number) {
    return {
      id: connection.id,
      employeeId: connection.employeeId,
      provider: connection.provider,
      status: connection.status,
      accountEmail: connection.accountEmail,
      calendarId: connection.calendarId,
      calendarName: connection.calendarName,
      calendarTimeZone: connection.calendarTimeZone,
      syncCompleted: connection.syncCompleted,
      useForAvailability: connection.useForAvailability,
      lastSyncAt: connection.lastSyncAt,
      busySyncedAt: connection.busySyncedAt,
      lastError: connection.lastError,
      lastErrorAt: connection.lastErrorAt,
      failedEvents,
      createdAt: connection.createdAt,
    };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toApiError(error: unknown): Error {
  if (error instanceof CalendarProviderError) {
    return error.kind === 'AUTH'
      ? new ConflictError('This calendar needs to be reconnected first.', {
          status: 'NEEDS_REAUTH',
        })
      : new CalendarProviderFailedError();
  }
  return error as Error;
}
