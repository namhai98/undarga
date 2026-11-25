import { randomInt, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SessionDenyList } from '../auth/session-deny-list';
import { TokenHashService } from '../auth/token-hash.service';
import { TokenService } from '../auth/token.service';
import {
  ConflictError,
  RefreshTokenReusedError,
  SessionRevokedError,
  SignInCodeInvalidError,
  TenantNotFoundError,
} from '../common/errors';
import { AppConfig } from '../config';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import { MailerService } from '../mail/mailer.service';
import type { CustomerActor } from '../tenancy/context/context.types';
import { TenantDirectoryService } from '../tenancy/directory/tenant-directory.service';
import { MembershipService } from '../tenancy/membership/membership.service';
import { CustomerIdentityRepository } from './customer-identity.repository';

const CODE_TTL_MS = 10 * 60_000;
/** Wrong guesses before a code is burnt. 5 in 10^6 is a 0.0005% chance. */
const MAX_ATTEMPTS = 5;
/** Codes per customer per hour; more is silently not sent. */
const MAX_CODES_PER_HOUR = 5;

export interface CustomerSessionTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

/**
 * ===========================================================================
 * CUSTOMER SIGN-IN: A CODE TO THE EMAIL ON FILE
 * ===========================================================================
 *
 * Customers book with a name and a phone or email; they never set a password,
 * so the portal does not ask for one. A six-digit code goes to the email the
 * COMPANY has on file for them, and entering it proves control of it.
 *
 *   - Per company. A token is minted for one company and one customer record
 *     (`CustomerAccessClaims.act` / `cc`), from the existing token service and
 *     audience model — a customer token is refused by every staff and platform
 *     route at the audience check.
 *   - No enumeration. "Send me a code" answers the same whether or not the
 *     address belongs to a customer, and whether or not a code went out.
 *   - Codes are stored as an HMAC, expire in ten minutes, die after five wrong
 *     guesses, and a new one voids the last. Five per hour per customer.
 *   - Sessions rotate like staff ones: refresh tokens are opaque, stored as an
 *     HMAC, rotated on every use; presenting a rotated one revokes the family.
 */
@Injectable()
export class CustomerAuthService {
  private readonly logger = new Logger(CustomerAuthService.name);

  constructor(
    private readonly db: TenantPrismaService,
    private readonly directory: TenantDirectoryService,
    private readonly memberships: MembershipService,
    private readonly identities: CustomerIdentityRepository,
    private readonly tokens: TokenService,
    private readonly hashes: TokenHashService,
    private readonly denyList: SessionDenyList,
    private readonly mailer: MailerService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async requestCode(slug: string, email: string) {
    const company = await this.company(slug);
    const now = new Date();

    const issued = await this.db.runInCompany(company.id, async (tx) => {
      const customer = await tx.companyCustomer.findFirst({
        where: { companyId: company.id, email, deletedAt: null, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!customer) return null;

      const recent = await tx.customerLoginCode.count({
        where: {
          companyId: company.id,
          companyCustomerId: customer.id,
          createdAt: { gte: new Date(now.getTime() - 3_600_000) },
        },
      });
      if (recent >= MAX_CODES_PER_HOUR) return null;

      // One live code at a time: a new request voids the previous one.
      await tx.customerLoginCode.updateMany({
        where: { companyId: company.id, companyCustomerId: customer.id, consumedAt: null },
        data: { consumedAt: now },
      });
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
      await tx.customerLoginCode.create({
        data: {
          companyId: company.id,
          companyCustomerId: customer.id,
          codeHash: this.hashCode(customer.id, code),
          expiresAt,
        },
      });
      return { code, expiresAt };
    });

    if (issued) {
      await this.mailer.sendCustomerSignInCode({
        to: email,
        companyName: company.name,
        code: issued.code,
        expiresAt: issued.expiresAt,
      });
    }
    // The same answer either way: whether this address is a customer here is
    // not something an anonymous caller learns.
    return { sent: true, expiresInSeconds: CODE_TTL_MS / 1000 };
  }

  async verify(
    slug: string,
    email: string,
    code: string,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<CustomerSessionTokens> {
    const company = await this.company(slug);
    const now = new Date();

    // Decided inside the transaction, thrown after it — so a wrong guess still
    // COMMITS its attempt count instead of rolling it back with the error.
    const outcome = await this.db.runInCompany(company.id, async (tx) => {
      const customer = await tx.companyCustomer.findFirst({
        where: { companyId: company.id, email, deletedAt: null, status: 'ACTIVE' },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          customerIdentityId: true,
        },
      });
      if (!customer) return null;

      const live = await tx.customerLoginCode.findFirst({
        where: {
          companyId: company.id,
          companyCustomerId: customer.id,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!live) return null;

      // Every write below is conditional and counts in the database, never from
      // the value read above: parallel guesses all read the same `attempts`,
      // and a read-then-write would let them overwrite one another's count.
      if (!this.hashes.matches(`customer-code:${customer.id}:${code}`, live.codeHash)) {
        await tx.customerLoginCode.updateMany({
          where: { id: live.id, companyId: company.id, consumedAt: null },
          data: { attempts: { increment: 1 } },
        });
        await tx.customerLoginCode.updateMany({
          where: {
            id: live.id,
            companyId: company.id,
            consumedAt: null,
            attempts: { gte: MAX_ATTEMPTS },
          },
          data: { consumedAt: now },
        });
        return null;
      }

      // The right code still loses if the code was burnt, or used up its
      // guesses, after we read it.
      const consumed = await tx.customerLoginCode.updateMany({
        where: {
          id: live.id,
          companyId: company.id,
          consumedAt: null,
          attempts: { lt: MAX_ATTEMPTS },
        },
        data: { consumedAt: now },
      });
      if (consumed.count === 0) return null;
      return customer;
    });

    if (!outcome) throw new SignInCodeInvalidError();
    const name = [outcome.firstName, outcome.lastName].filter(Boolean).join(' ');

    // The person behind the record. A record already linked keeps its identity;
    // otherwise the address just proved becomes one.
    let identityId = outcome.customerIdentityId;
    if (identityId) {
      if (!(await this.identities.usable(identityId))) throw new SignInCodeInvalidError();
    } else {
      const identity = await this.identities.findOrCreateVerified(email, name || null);
      if (identity.status !== 'ACTIVE') throw new SignInCodeInvalidError();
      identityId = identity.id;
      try {
        await this.db.runInCompany(company.id, (tx) =>
          tx.companyCustomer.updateMany({
            where: { id: outcome.id, companyId: company.id, customerIdentityId: null },
            data: { customerIdentityId: identityId },
          }),
        );
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          // That person is already a different customer record here.
          throw new ConflictError(
            'This email is linked to another customer record at this business. Contact them.',
          );
        }
        throw error;
      }
    }

    const session = await this.openSession(company.id, outcome.id, identityId, randomUUID(), meta);
    // Under the customer just authenticated, not the anonymous request.
    await this.audit.recordAs(
      {
        kind: 'CUSTOMER',
        customerIdentityId: identityId,
        companyCustomerId: outcome.id,
        companyId: company.id,
        sessionId: session.id,
      },
      { action: 'customer.signed_in', resourceType: 'company_customer', resourceId: outcome.id },
      company.id,
    );
    return this.issue({
      companyId: company.id,
      companyCustomerId: outcome.id,
      customerIdentityId: identityId,
      sessionId: session.id,
      refreshToken: session.refreshToken,
      email,
      name,
    });
  }

  /** Rotate a refresh token. Reusing a rotated one revokes the whole family. */
  async refresh(
    slug: string,
    refreshToken: string | null,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<CustomerSessionTokens> {
    if (!refreshToken) throw new SessionRevokedError();
    const company = await this.company(slug);
    const now = new Date();

    // Check, claim, open and link in ONE transaction. The claim is conditional
    // on the old session still being live, so of two refreshes racing on one
    // token only one rotates; the other is treated as reuse.
    const result = await this.db.runInCompany(company.id, async (tx) => {
      const session = await tx.customerSession.findFirst({
        where: { companyId: company.id, tokenHash: this.hashes.hash(refreshToken) },
      });
      if (!session) return { kind: 'invalid' as const };

      const revokeFamily = async () => {
        const family = await tx.customerSession.findMany({
          where: { companyId: company.id, familyId: session.familyId, revokedAt: null },
          select: { id: true },
        });
        await tx.customerSession.updateMany({
          where: { companyId: company.id, familyId: session.familyId, revokedAt: null },
          data: { revokedAt: now },
        });
        return { kind: 'reused' as const, killed: family.map((f) => f.id) };
      };

      if (session.revokedAt || session.replacedById) return revokeFamily();
      if (session.expiresAt <= now) return { kind: 'invalid' as const };

      const customer = await tx.companyCustomer.findFirst({
        where: {
          id: session.companyCustomerId,
          companyId: company.id,
          deletedAt: null,
          status: 'ACTIVE',
          customerIdentityId: session.customerIdentityId,
        },
        select: { id: true, firstName: true, lastName: true, email: true },
      });
      if (!customer) {
        await tx.customerSession.updateMany({
          where: { id: session.id, companyId: company.id },
          data: { revokedAt: now },
        });
        return { kind: 'invalid' as const };
      }

      const claimed = await tx.customerSession.updateMany({
        where: { id: session.id, companyId: company.id, revokedAt: null, replacedById: null },
        data: { revokedAt: now },
      });
      if (claimed.count === 0) return revokeFamily();

      const next = await this.createSession(
        tx,
        company.id,
        customer.id,
        session.customerIdentityId,
        session.familyId,
        meta,
      );
      await tx.customerSession.updateMany({
        where: { id: session.id, companyId: company.id },
        data: { replacedById: next.id },
      });
      return { kind: 'ok' as const, session, customer, next };
    });

    if (result.kind === 'reused') {
      result.killed.forEach((id) => this.denyList.revoke(id));
      this.logger.warn(
        `Customer refresh token reuse detected; ${result.killed.length} sessions revoked`,
      );
      throw new RefreshTokenReusedError();
    }
    if (result.kind === 'invalid') throw new SessionRevokedError();

    // The old session's access token stops working now, as for staff.
    this.denyList.revoke(result.session.id);
    const next = result.next;

    return this.issue({
      companyId: company.id,
      companyCustomerId: result.customer.id,
      customerIdentityId: result.session.customerIdentityId,
      sessionId: next.id,
      refreshToken: next.refreshToken,
      email: result.customer.email ?? '',
      name: [result.customer.firstName, result.customer.lastName].filter(Boolean).join(' '),
    });
  }

  async logout(actor: CustomerActor): Promise<void> {
    await this.db.runInCompany(actor.companyId, (tx) =>
      tx.customerSession.updateMany({
        where: { id: actor.sessionId, companyId: actor.companyId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
    // The access token stops working now, not when it expires.
    this.denyList.revoke(actor.sessionId);
  }

  // ---------------------------------------------------------------------------

  /** Only a live company has a portal, exactly as for public booking. */
  private async company(slug: string): Promise<{ id: string; name: string }> {
    const companyId = await this.directory.findCompanyIdBySlug(slug);
    if (!companyId) throw new TenantNotFoundError();
    await this.memberships.authorizePublic(companyId);
    const company = await this.db.runInCompany(companyId, (tx) =>
      tx.company.findFirstOrThrow({ where: { id: companyId }, select: { displayName: true } }),
    );
    return { id: companyId, name: company.displayName };
  }

  private hashCode(customerId: string, code: string): string {
    return this.hashes.hash(`customer-code:${customerId}:${code}`);
  }

  private async openSession(
    companyId: string,
    companyCustomerId: string,
    customerIdentityId: string,
    familyId: string,
    meta: { ipAddress?: string; userAgent?: string },
  ) {
    return this.db.runInCompany(companyId, (tx) =>
      this.createSession(tx, companyId, companyCustomerId, customerIdentityId, familyId, meta),
    );
  }

  private async createSession(
    tx: TenantTx,
    companyId: string,
    companyCustomerId: string,
    customerIdentityId: string,
    familyId: string,
    meta: { ipAddress?: string; userAgent?: string },
  ) {
    const refreshToken = this.hashes.generate();
    const row = await tx.customerSession.create({
      data: {
        companyId,
        companyCustomerId,
        customerIdentityId,
        tokenHash: this.hashes.hash(refreshToken),
        familyId,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
        expiresAt: new Date(Date.now() + this.config.auth.refreshTokenTtlDays * 86_400_000),
      },
      select: { id: true },
    });
    return { id: row.id, refreshToken };
  }

  private issue(input: {
    companyId: string;
    companyCustomerId: string;
    customerIdentityId: string;
    sessionId: string;
    refreshToken: string;
    email: string;
    name: string;
  }): CustomerSessionTokens {
    return {
      accessToken: this.tokens.signCustomerAccess({
        customerIdentityId: input.customerIdentityId,
        companyCustomerId: input.companyCustomerId,
        companyId: input.companyId,
        sessionId: input.sessionId,
        email: input.email,
        name: input.name,
      }),
      refreshToken: input.refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.config.auth.jwtAccessTtlSeconds,
    };
  }
}
