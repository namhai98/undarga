import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppConfig } from '../config';
import { PlatformPrismaService } from '../database/platform-prisma.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { actorId, actorLabel, isPlatformUser } from '../tenancy/context/context.types';

export interface AuditEvent {
  /** Dotted verb, e.g. `appointment.cancelled`, `member.role_changed`. */
  action: string;
  resourceType: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  /**
   * Force a platform-level row (companyId null) even inside a tenant context.
   * Used for actions that are about the company rather than within it, such as
   * suspending it.
   */
  platformLevel?: boolean;
}

/**
 * Writes the audit trail.
 *
 * ---------------------------------------------------------------------------
 * TENANT INFORMATION IS NEVER PASSED IN
 * ---------------------------------------------------------------------------
 *
 * Callers supply what happened; the company, the actor and the request id come
 * from the ambient context. A caller cannot attribute an action to the wrong
 * company, because there is no parameter with which to do so.
 *
 * ---------------------------------------------------------------------------
 * COMPANY-LEVEL vs PLATFORM-LEVEL
 * ---------------------------------------------------------------------------
 *
 * `companyId` present  -> something happened inside a tenant.
 * `companyId` null     -> something happened to the platform or to a company
 *                         from outside it (provisioning, suspension, a plan
 *                         change).
 *
 * The two are distinguishable by that column alone, and RLS makes NULL rows
 * invisible to tenants — a company can read its own trail and nothing else.
 * Because of that policy, platform rows must be written on the platform
 * connection; there is no tenant to set.
 *
 * A row written while a platform operator is inside a company keeps the
 * company id (it *did* happen in that tenant) and additionally records the
 * operator and any impersonation grant, so "who touched this customer record"
 * has an honest answer.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly platformDb: PlatformPrismaService,
    private readonly context: RequestContextService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Record an event.
   *
   * Never throws. An audit write that fails must not roll back the business
   * action that succeeded — but it is logged at error level, because a silent
   * gap in the trail is exactly what an attacker wants.
   *
   * That trade means the trail is best-effort. For actions where a missing row
   * is unacceptable (refunds, gift-card adjustments, permission changes), the
   * write should move inside the caller's own transaction so it commits or
   * fails with the action. That variant is not built yet and is listed as a
   * follow-up.
   */
  async record(event: AuditEvent): Promise<void> {
    return this.write(event, undefined);
  }

  /**
   * Record an event against a named company, for flows that legitimately act on
   * one before a tenant context exists.
   *
   * There is exactly one such flow today: accepting an invitation. That route is
   * `@Public()` and `@NoTenant()` — it must be, because the caller has no
   * session and no company yet — so `record()` would file "someone joined" as a
   * platform row with `company_id` NULL, which RLS then hides from the very
   * company it happened to. The company would never see its own membership
   * changes.
   *
   * `companyId` is the FIRST parameter so it cannot be missed in review. This
   * is deliberately NOT a general escape from the rule that tenant information
   * is never passed in: the id must come from a server-side lookup the caller
   * cannot influence — the invitation row, here — never from a request body,
   * a header or a route parameter.
   */
  async recordForCompany(companyId: string, event: AuditEvent): Promise<void> {
    return this.write(event, companyId);
  }

  private async write(event: AuditEvent, forCompanyId: string | undefined): Promise<void> {
    try {
      const ctx = this.context.peek();
      const actor = ctx?.actor ?? { kind: 'SYSTEM' as const, name: 'unknown' };
      const tenant = event.platformLevel ? null : (ctx?.tenant ?? null);

      const row = {
        // An explicit company wins over the ambient one; `platformLevel` still
        // wins over both, so "this is about the company, not within it" stays
        // expressible.
        companyId: event.platformLevel ? null : (forCompanyId ?? tenant?.company.id ?? null),
        occurredAt: new Date(),
        actorType: actor.kind,
        actorId: actorId(actor),
        // Denormalised deliberately: an audit trail that needs a join to a
        // mutable table to be readable is not an audit trail.
        actorLabel: actorLabel(actor),
        impersonationGrantId:
          isPlatformUser(actor) && actor.impersonation ? actor.impersonation.grantId : null,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId ?? null,
        before: redact(event.before),
        after: redact(event.after),
        metadata: {
          ...(event.metadata ?? {}),
          ...(tenant ? { tenantSource: tenant.source } : {}),
          ...(tenant?.viaPlatformAccess ? { viaPlatformAccess: true } : {}),
        },
        ipAddress: ctx?.ipAddress ?? null,
        userAgent: ctx?.userAgent?.slice(0, 512) ?? null,
        requestId: ctx?.requestId ?? null,
      };

      if (row.companyId) {
        await this.writeCompanyRow(row.companyId, row);
      } else {
        await this.writePlatformRow(row);
      }
    } catch (error) {
      this.logger.error(
        `Failed to write audit row for "${event.action}" on ${event.resourceType}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async writeCompanyRow(companyId: string, row: AuditRow): Promise<void> {
    await this.tenantDb.runInCompany(companyId, async (tx) => {
      const prevHash = this.config.audit.hashChain
        ? await this.lockAndReadPreviousHash(tx, companyId)
        : null;

      await tx.auditLog.create({
        data: {
          ...toPrismaData(row),
          prevHash,
          rowHash: hashRow(row, prevHash),
        },
      });
    });
  }

  private async writePlatformRow(row: AuditRow): Promise<void> {
    // No tenant to set; RLS would hide a NULL-company row from the tenant
    // connection anyway.
    await this.platformDb.auditLog.create({
      data: { ...toPrismaData(row), prevHash: null, rowHash: hashRow(row, null) },
    });
  }

  /**
   * Take the previous row's hash under a per-company advisory lock.
   *
   * ---------------------------------------------------------------------------
   * COST, STATED PLAINLY
   * ---------------------------------------------------------------------------
   *
   * A hash chain is only tamper-evident if the rows are totally ordered, which
   * means audit writes for one company serialise. Under sustained booking load
   * that lock is a contention point on the busiest tenant.
   *
   * It is on by default because a trail nobody can verify is worth less than
   * the throughput it saves, and `AUDIT_HASH_CHAIN=false` turns it off for a
   * tenant that outgrows it. The better long-term answer is to chain
   * asynchronously in a worker off the outbox, leaving the write path
   * unserialised — that is noted as a follow-up rather than built here.
   *
   * The lock is transaction-scoped, so it is released on COMMIT or ROLLBACK
   * with no possibility of leaking.
   */
  private async lockAndReadPreviousHash(tx: TenantTx, companyId: string): Promise<Buffer | null> {
    // `$executeRaw`, not `$queryRaw`.
    //
    // `pg_advisory_xact_lock` returns `void`, and Prisma 5's $queryRaw tries to
    // deserialize every returned column — it has no mapping for void and throws
    // "Failed to deserialize column of type 'void'". Because AuditService
    // swallows its own failures by design (an audit write must not roll back
    // the business action that succeeded), that error surfaced only as an
    // ERROR log line, and every hash-chained company audit row was silently
    // being dropped. $executeRaw takes the same lock and returns a row count,
    // which needs no deserialization.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${companyId}))`);

    const rows = await tx.$queryRaw<Array<{ row_hash: Buffer }>>(
      Prisma.sql`
        SELECT row_hash
          FROM audit_log
         WHERE company_id = ${companyId}::uuid
         ORDER BY occurred_at DESC, id DESC
         LIMIT 1
      `,
    );

    return rows[0]?.row_hash ?? null;
  }
}

interface AuditRow {
  companyId: string | null;
  occurredAt: Date;
  actorType: string;
  actorId: string | null;
  actorLabel: string;
  impersonationGrantId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

function toPrismaData(row: AuditRow) {
  return {
    companyId: row.companyId,
    occurredAt: row.occurredAt,
    actorType: row.actorType as never,
    actorId: row.actorId,
    actorLabel: row.actorLabel,
    impersonationGrantId: row.impersonationGrantId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    before: (row.before ?? undefined) as never,
    after: (row.after ?? undefined) as never,
    metadata: row.metadata as never,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    requestId: row.requestId,
  };
}

function hashRow(row: AuditRow, prevHash: Buffer | null): Buffer {
  const canonical = JSON.stringify([
    row.companyId,
    row.occurredAt.toISOString(),
    row.actorType,
    row.actorId,
    row.action,
    row.resourceType,
    row.resourceId,
    row.before ?? null,
    row.after ?? null,
  ]);

  return createHash('sha256')
    .update(prevHash ?? Buffer.alloc(0))
    .update(canonical)
    .digest();
}

/**
 * Strip anything that must never be persisted, by ALLOW-list on the key name.
 *
 * A deny-list ("remove `password`") leaks the first time someone adds
 * `passwordResetToken`. This removes any key that looks like a credential and
 * keeps the rest, which is the safer direction to be wrong in — a redacted
 * field costs a support engineer some guesswork; a leaked one costs an
 * incident.
 *
 * TODO before the first business module ships: replace this heuristic with a
 * per-resource-type field allow-list, so a new sensitive column is opt-in to
 * the audit trail rather than opt-out. Noted in the report.
 */
const SENSITIVE_KEY =
  /pass|secret|token|hash|pepper|salt|credential|authorization|cookie|pin|cvv|card/i;

function redact(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(val);
  }
  return out;
}
