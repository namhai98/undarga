import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config';
import { AuditService } from '../audit/audit.service';
import { ConflictError, ResourceNotFoundError, ValidationFailedError } from '../common/errors';
import { PrivilegeEscalationError } from '../common/errors';
import { TokenHashService } from '../auth/token-hash.service';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import { InvitationRepository } from './invitation.repository';
import type { CreateInvitationDto, ListInvitationsDto } from './dto/invitation.dto';

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface InvitationSummary {
  id: string;
  email: string;
  status: InvitationStatus;
  roles: Array<{ key: string; name: string }>;
  expiresAt: Date;
  createdAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export interface CreatedInvitation extends InvitationSummary {
  /**
   * Plaintext, returned EXACTLY ONCE — here and on rotate. Never stored, never
   * listed, never logged, never put in an audit payload.
   */
  token: string;
  /** Absent when WEB_APP_URL is not configured. */
  acceptUrl?: string;
}

/**
 * Derive status from timestamps.
 *
 * Status is not a stored column, so it cannot drift out of step with the
 * timestamps that justify it — and expiry needs no scheduled job to take
 * effect. A row is expired the moment the clock passes `expiresAt`, on every
 * read, everywhere.
 */
export function statusOf(row: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): InvitationStatus {
  if (row.acceptedAt) return 'ACCEPTED';
  if (row.revokedAt) return 'REVOKED';
  if (row.expiresAt.getTime() <= Date.now()) return 'EXPIRED';
  return 'PENDING';
}

/**
 * Creating, rotating and revoking invitations.
 *
 * Accepting one is deliberately elsewhere (InvitationAcceptService): this class
 * runs inside a tenant context with an authenticated administrator, and that
 * one runs with neither. Keeping them apart means neither file has to keep
 * asking which world it is in.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE SENDS EMAIL
 * ---------------------------------------------------------------------------
 *
 * There is no mail transport in the system yet. Rather than pretend, the
 * plaintext token is returned to the administrator once and they distribute the
 * link themselves. When the notification outbox lands in phase 6, sending
 * becomes an additional side effect of `create` — the token handling, the
 * expiry and the state machine do not change.
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly invitations: InvitationRepository,
    private readonly db: TenantPrismaService,
    private readonly context: RequestContextService,
    private readonly hashes: TokenHashService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  async create(input: CreateInvitationDto): Promise<CreatedInvitation> {
    const tenant = this.context.requireTenant('create invitation');
    const email = input.email.toLowerCase();

    const token = this.hashes.generate();
    const expiresAt = this.expiryFrom(input.expiresInDays);

    const created = await this.invitations.transaction(async (tx, companyId) => {
      const roles = await this.resolveRoles(tx, companyId, input.roleKeys);
      await this.assertNoEscalation(tx, companyId, roles.map((r) => r.id));
      await this.assertNotAlreadyAMember(tx, companyId, email);
      await this.assertNoLiveInvitation(tx, companyId, email);

      const invitation = await tx.companyInvitation.create({
        data: {
          companyId,
          email,
          tokenHash: this.hashes.hash(token),
          expiresAt,
          // Null for a platform operator acting inside the tenant: they hold
          // no membership, by design.
          invitedByCompanyUserId: tenant.membership?.companyUserId ?? null,
        },
      });

      await tx.companyInvitationRole.createMany({
        data: roles.map((role) => ({ companyId, invitationId: invitation.id, roleId: role.id })),
      });

      return { invitation, roles };
    });

    await this.audit.record({
      action: 'member.invited',
      resourceType: 'company_invitation',
      resourceId: created.invitation.id,
      // The token is absent on purpose. `redact()` would catch a key named
      // `token`, but relying on a denylist for a live credential is the wrong
      // posture — the safe move is not to put it in the object.
      after: { email, roleKeys: created.roles.map((r) => r.key), expiresAt },
    });

    return {
      ...this.toSummary(created.invitation, created.roles),
      token,
      ...this.acceptUrl(token),
    };
  }

  // ---------------------------------------------------------------------------
  // Rotate
  // ---------------------------------------------------------------------------

  /**
   * Issue a new token for an existing invitation.
   *
   * This is "resend the link" — and it must invalidate the previous one, or
   * "resend" quietly leaves two live credentials where the administrator
   * believes there is one, and revoking the visible one closes nothing.
   * Overwriting the hash kills the old link instantly.
   */
  async rotate(invitationId: string, expiresInDays?: number): Promise<CreatedInvitation> {
    const token = this.hashes.generate();
    const expiresAt = this.expiryFrom(expiresInDays);

    const rotated = await this.invitations.transaction(async (tx, companyId) => {
      const { count } = await tx.companyInvitation.updateMany({
        // Only a live invitation may be rotated. Reviving an accepted or
        // revoked one would resurrect a decision someone already made.
        where: { companyId, id: invitationId, acceptedAt: null, revokedAt: null },
        data: { tokenHash: this.hashes.hash(token), expiresAt },
      });

      if (count === 0) {
        // Covers "no such invitation", "belongs to another company" and
        // "already accepted or revoked" with one indistinguishable answer.
        throw new ResourceNotFoundError('CompanyInvitation', invitationId);
      }

      return this.loadWithRoles(tx, companyId, invitationId);
    });

    await this.audit.record({
      action: 'member.invitation_rotated',
      resourceType: 'company_invitation',
      resourceId: invitationId,
      after: { email: rotated.invitation.email, expiresAt },
    });

    return {
      ...this.toSummary(rotated.invitation, rotated.roles),
      token,
      ...this.acceptUrl(token),
    };
  }

  // ---------------------------------------------------------------------------
  // Revoke
  // ---------------------------------------------------------------------------

  async revoke(invitationId: string): Promise<void> {
    const revoked = await this.invitations.transaction(async (tx, companyId) => {
      const { count } = await tx.companyInvitation.updateMany({
        where: { companyId, id: invitationId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return count > 0;
    });

    if (!revoked) {
      // Idempotent in effect but honest in reporting: a second revoke of the
      // same invitation 404s rather than claiming to have done something.
      throw new ResourceNotFoundError('CompanyInvitation', invitationId);
    }

    await this.audit.record({
      action: 'member.invitation_revoked',
      resourceType: 'company_invitation',
      resourceId: invitationId,
    });
  }

  // ---------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------

  async list(query: ListInvitationsDto): Promise<{ items: InvitationSummary[]; total: number }> {
    return this.invitations.transaction(async (tx, companyId) => {
      const where =
        query.status === 'live'
          ? { companyId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }
          : { companyId };

      const [rows, total] = await Promise.all([
        tx.companyInvitation.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: query.offset,
          take: query.limit,
          include: { roles: { include: { role: true } } },
        }),
        tx.companyInvitation.count({ where }),
      ]);

      return {
        // No token field anywhere in this shape. The plaintext exists in one
        // response and is unrecoverable afterwards — only its HMAC is stored,
        // so a listing physically cannot hand it back.
        items: rows.map((row) =>
          this.toSummary(
            row,
            row.roles.map((r) => r.role),
          ),
        ),
        total,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  private async resolveRoles(tx: TenantTx, companyId: string, keys: string[]) {
    const unique = [...new Set(keys)];
    const roles = await tx.companyRole.findMany({
      where: { companyId, key: { in: unique }, deletedAt: null },
      select: { id: true, key: true, name: true },
    });

    const missing = unique.filter((key) => !roles.some((r) => r.key === key));
    if (missing.length > 0) {
      // 400 rather than 404: the request named something that does not exist in
      // this company, which is a bad field, not a missing resource. Listing the
      // unknown keys is safe — the caller already holds member:invite here.
      throw new ValidationFailedError({ roleKeys: `Unknown role(s): ${missing.join(', ')}.` });
    }

    return roles;
  }

  /**
   * An inviter may not grant more than they hold.
   *
   * Without this, `member:invite` alone is a path to owner-equivalent access:
   * invite an address you control, attach the OWNER role, accept. The check is
   * on the union of PERMISSIONS rather than on role names, because what matters
   * is the capability being handed over, not the label on it.
   *
   * A platform operator inside the tenant holds every company permission by
   * construction, so they pass — which is intended, and every action they take
   * is already flagged `viaPlatformAccess` in the audit trail.
   */
  private async assertNoEscalation(
    tx: TenantTx,
    companyId: string,
    roleIds: string[],
  ): Promise<void> {
    const tenant = this.context.requireTenant('invitation escalation check');

    // The owner holds everything; nothing can exceed it.
    if (tenant.membership?.isOwner) return;

    const granted = await tx.companyRolePermission.findMany({
      where: { companyId, roleId: { in: roleIds } },
      select: { permissionKey: true },
    });

    const missing = [
      ...new Set(
        granted.map((g) => g.permissionKey).filter((key) => !tenant.permissions.has(key)),
      ),
    ].sort();

    if (missing.length > 0) {
      throw new PrivilegeEscalationError(missing);
    }
  }

  private async assertNotAlreadyAMember(
    tx: TenantTx,
    companyId: string,
    email: string,
  ): Promise<void> {
    // `user_account` is readable from the tenant connection only through the
    // membership policy (001_hardening.sql 8e), so this join is itself scoped:
    // it can see an account only if that account is already a member HERE.
    // A non-member's existence is not observable, which is the property that
    // stops this endpoint being an account-enumeration oracle.
    const existing = await tx.companyUser.findFirst({
      where: { companyId, deletedAt: null, userAccount: { email } },
      select: { id: true, status: true },
    });

    if (existing) {
      throw new ConflictError('That person is already a member of this company.', {
        field: 'email',
        companyUserId: existing.id,
        memberStatus: existing.status,
      });
    }
  }

  private async assertNoLiveInvitation(
    tx: TenantTx,
    companyId: string,
    email: string,
  ): Promise<void> {
    const live = await tx.companyInvitation.findFirst({
      where: { companyId, email, acceptedAt: null, revokedAt: null },
      select: { id: true, expiresAt: true },
    });

    if (!live) return;

    // An EXPIRED-but-not-revoked row still occupies the partial unique index,
    // so creating a second one would fail at the constraint. Rotating is what
    // the administrator actually wants, and the id tells the UI how to offer it.
    throw new ConflictError(
      statusOf({ ...live, acceptedAt: null, revokedAt: null }) === 'EXPIRED'
        ? 'An expired invitation for that address is still on file. Rotate it to send a new link.'
        : 'An invitation for that address is already outstanding.',
      { field: 'email', invitationId: live.id },
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private expiryFrom(days?: number): Date {
    const ttl = days ?? this.config.auth.invitationTtlDays;
    return new Date(Date.now() + ttl * 86_400_000);
  }

  /**
   * Build the link from CONFIGURED origin, never from the request Host header.
   *
   * Host-header injection would otherwise produce an invitation pointing at an
   * attacker's domain, and the recipient would hand over a valid one-time token
   * by following it. When WEB_APP_URL is unset the caller gets the bare token
   * and builds their own link.
   */
  private acceptUrl(token: string): { acceptUrl?: string } {
    const base = this.config.app.webAppUrl;
    if (!base) return {};
    return {
      acceptUrl: `${base.replace(/\/+$/, '')}/invitations/accept?token=${encodeURIComponent(token)}`,
    };
  }

  private async loadWithRoles(tx: TenantTx, companyId: string, invitationId: string) {
    const invitation = await tx.companyInvitation.findFirst({
      where: { companyId, id: invitationId },
      include: { roles: { include: { role: true } } },
    });

    if (!invitation) throw new ResourceNotFoundError('CompanyInvitation', invitationId);

    return { invitation, roles: invitation.roles.map((r) => r.role) };
  }

  private toSummary(
    row: {
      id: string;
      email: string;
      expiresAt: Date;
      createdAt: Date;
      acceptedAt: Date | null;
      revokedAt: Date | null;
    },
    roles: Array<{ key: string; name: string }>,
  ): InvitationSummary {
    return {
      id: row.id,
      email: row.email,
      status: statusOf(row),
      roles: roles.map((r) => ({ key: r.key, name: r.name })),
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      acceptedAt: row.acceptedAt,
      revokedAt: row.revokedAt,
    };
  }
}
