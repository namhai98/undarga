import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config';
import {
  InvalidCredentialsError,
  RefreshTokenReusedError,
  SessionRevokedError,
  TenantNotFoundError,
  UnauthenticatedError,
} from '../common/errors';
import { TenantDirectoryService } from '../tenancy/directory/tenant-directory.service';
import { normalizeEmail } from './normalize-email';
import { IdentityRepository } from './identity.repository';
import { PasswordService } from './password.service';
import { SessionDenyList } from './session-deny-list';
import { TokenHashService } from './token-hash.service';
import { TokenService } from './token.service';
import type { IssuedTokens } from './token.types';

export interface MembershipSummary {
  companyId: string;
  companySlug: string;
  companyName: string;
  isOwner: boolean;
}

export interface AuthenticatedSession extends IssuedTokens {
  memberships: MembershipSummary[];
}

/**
 * Authentication and active-company selection.
 *
 * ---------------------------------------------------------------------------
 * MULTIPLE MEMBERSHIPS ARE THE NORMAL CASE
 * ---------------------------------------------------------------------------
 *
 * A user may belong to any number of companies with a different role in each.
 * Nothing here binds an account to one company:
 *
 *   - Login returns the full membership list and selects a *default* active
 *     company (the first, deterministically ordered) purely so the common
 *     single-company user is not forced through a picker.
 *   - The active company lives in the token, so it is per-session rather than
 *     per-account. The same person can be signed in to two companies in two
 *     browsers.
 *   - Switching issues a NEW token rather than mutating state, so a token is
 *     always valid for exactly one company. There is no window in which a token
 *     means two things.
 *
 * The active company is still only a hint: TenantGuard re-validates membership
 * on every request, so a token naming a company the user was just removed from
 * stops working immediately rather than at expiry.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly identity: IdentityRepository,
    private readonly directory: TenantDirectoryService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly hashes: TokenHashService,
    private readonly denyList: SessionDenyList,
    private readonly config: AppConfig,
  ) {}

  // -------------------------------------------------------------------------
  // Staff
  // -------------------------------------------------------------------------

  async loginStaff(
    email: string,
    password: string,
    meta: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<AuthenticatedSession> {
    const user = await this.identity.findStaffByEmail(normalizeEmail(email));

    // Every failure below raises the identical error. "No such user", "wrong
    // password", "account disabled" and "locked out" are indistinguishable to
    // the caller, so the login endpoint cannot be used to enumerate accounts.
    // The password is still verified against a dummy hash when the user does
    // not exist (see PasswordService.verify) so the timing matches too.
    if (!user) {
      await this.passwords.verify(null, password);
      throw new InvalidCredentialsError();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.passwords.verify(null, password);
      throw new InvalidCredentialsError();
    }

    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok) {
      await this.identity.recordStaffLoginFailure(user.id);
      throw new InvalidCredentialsError();
    }

    if (user.status !== 'ACTIVE') {
      throw new InvalidCredentialsError();
    }

    await this.identity.recordStaffLoginSuccess(user.id);

    const memberships = await this.directory.listMembershipsForUser(user.id);
    // Deterministic default so a single-company user never sees a picker. A
    // user with no memberships still gets a valid token — they can be invited
    // to a company, and their token simply carries no active company until then.
    const active = memberships[0];

    const issued = await this.issueStaffSession({
      userAccountId: user.id,
      email: user.email,
      name: user.fullName,
      activeCompanyId: active?.companyId,
      companyUserId: active?.companyUserId,
      meta,
    });

    return { ...issued, memberships: memberships.map(toSummary) };
  }

  /**
   * Switch the active company.
   *
   * Validates membership here as well as in TenantGuard. Belt and braces: this
   * is the one endpoint whose entire purpose is to change which company a token
   * points at, so it should not depend on a downstream guard to be correct.
   */
  async switchCompany(
    userAccountId: string,
    sessionId: string,
    targetCompanyId: string,
  ): Promise<AuthenticatedSession> {
    const user = await this.identity.findStaffById(userAccountId);
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthenticatedError();
    }

    const memberships = await this.directory.listMembershipsForUser(userAccountId);
    const target = memberships.find((m) => m.companyId === targetCompanyId);

    if (!target) {
      // Same 404 as everywhere else: switching to a company you do not belong
      // to must not confirm that the company exists.
      throw new TenantNotFoundError();
    }

    // The old session is retired rather than reused, so a leaked token cannot
    // be replayed against the new company.
    this.denyList.revoke(sessionId);
    await this.identity.revokeStaffSession(sessionId);

    const issued = await this.issueStaffSession({
      userAccountId: user.id,
      email: user.email,
      name: user.fullName,
      activeCompanyId: target.companyId,
      companyUserId: target.companyUserId,
      meta: {},
    });

    this.logger.log(`User ${userAccountId} switched active company to ${target.companyId}`);

    return { ...issued, memberships: memberships.map(toSummary) };
  }

  /**
   * Rotate a refresh token.
   *
   * Reuse of an already-rotated token kills the whole family. See
   * IdentityRepository.revokeStaffSessionFamily for why that trade is correct.
   */
  async refreshStaff(
    refreshToken: string,
    meta: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<AuthenticatedSession> {
    const tokenHash = this.hashes.hash(refreshToken);
    const session = await this.identity.findStaffSessionByHash(tokenHash);

    if (!session) {
      throw new SessionRevokedError();
    }

    if (session.revokedAt || session.replacedById) {
      const killed = await this.identity.revokeStaffSessionFamily(session.familyId);
      killed.forEach((id) => this.denyList.revoke(id));
      this.logger.warn(
        `Refresh token reuse detected for family ${session.familyId}; ${killed.length} sessions revoked`,
      );
      throw new RefreshTokenReusedError();
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new SessionRevokedError();
    }

    const user = await this.identity.findStaffById(session.userAccountId);
    if (!user || user.status !== 'ACTIVE') {
      throw new SessionRevokedError();
    }

    const memberships = await this.directory.listMembershipsForUser(user.id);

    // Carry the session's active company across the rotation.
    //
    // A refresh presents only the refresh token, so the expiring access token —
    // which held the active company — is not available here. Reading it back
    // from the session is what stops a rotation from silently returning the
    // user to their first membership fifteen minutes after they switched.
    //
    // The stored value is a hint and is re-validated: if the membership behind
    // it was revoked, or the row is stale, it is dropped and the default
    // applies. Nothing is authorized on the strength of the hint alone.
    const remembered = session.activeCompanyId
      ? memberships.find((m) => m.companyId === session.activeCompanyId)
      : undefined;
    const active = remembered ?? memberships[0];

    if (session.activeCompanyId && !remembered) {
      this.logger.log(
        `Session ${session.id} pointed at company ${session.activeCompanyId}, ` +
          'which is no longer a live membership; falling back to the default.',
      );
    }

    const nextToken = this.hashes.generate();
    const next = await this.identity.rotateStaffSession({
      previousSessionId: session.id,
      userAccountId: user.id,
      tokenHash: this.hashes.hash(nextToken),
      familyId: session.familyId,
      expiresAt: this.refreshExpiry(),
      activeCompanyId: active?.companyId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    this.denyList.revoke(session.id);

    const accessToken = this.tokens.signStaffAccess({
      userAccountId: user.id,
      sessionId: next.id,
      email: user.email,
      name: user.fullName,
      activeCompanyId: active?.companyId,
      companyUserId: active?.companyUserId,
    });

    return {
      accessToken,
      refreshToken: nextToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds,
      activeCompanyId: active?.companyId,
      memberships: memberships.map(toSummary),
    };
  }

  async logoutStaff(sessionId: string): Promise<void> {
    this.denyList.revoke(sessionId);
    await this.identity.revokeStaffSession(sessionId);
  }

  async listMemberships(userAccountId: string): Promise<MembershipSummary[]> {
    const memberships = await this.directory.listMembershipsForUser(userAccountId);
    return memberships.map(toSummary);
  }

  // -------------------------------------------------------------------------
  // Platform
  // -------------------------------------------------------------------------

  /**
   * Operator sign-in.
   *
   * MFA IS NOT ENFORCED HERE YET. `mfaEnrolledAt` is read and logged, but the
   * second factor challenge is not implemented — that is called out as a
   * blocking item in the report rather than silently skipped. This realm must
   * not reach production without it.
   */
  async loginPlatform(
    email: string,
    password: string,
    meta: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<IssuedTokens> {
    const user = await this.identity.findPlatformUserByEmail(normalizeEmail(email));

    if (!user) {
      await this.passwords.verify(null, password);
      throw new InvalidCredentialsError();
    }

    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok || user.status !== 'ACTIVE') {
      throw new InvalidCredentialsError();
    }

    if (!user.mfaEnrolledAt) {
      this.logger.error(
        `Platform user ${user.id} signed in without MFA enrolment. This realm requires a ` +
          'second factor before production use.',
      );
    }

    await this.identity.recordPlatformLogin(user.id);

    const refreshToken = this.hashes.generate();
    const session = await this.identity.createPlatformSession({
      platformUserId: user.id,
      tokenHash: this.hashes.hash(refreshToken),
      familyId: randomUUID(),
      expiresAt: this.refreshExpiry(),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    this.logger.warn(`Platform operator ${user.email} signed in (session ${session.id})`);

    return {
      accessToken: this.tokens.signPlatformAccess({
        platformUserId: user.id,
        sessionId: session.id,
        email: user.email,
        name: user.fullName,
      }),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds,
    };
  }

  async logoutPlatform(sessionId: string): Promise<void> {
    this.denyList.revoke(sessionId);
    await this.identity.revokePlatformSession(sessionId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async issueStaffSession(input: {
    userAccountId: string;
    email: string;
    name: string;
    activeCompanyId?: string;
    companyUserId?: string;
    meta: { ipAddress?: string; userAgent?: string };
  }): Promise<IssuedTokens> {
    const refreshToken = this.hashes.generate();
    const session = await this.identity.createStaffSession({
      userAccountId: input.userAccountId,
      tokenHash: this.hashes.hash(refreshToken),
      familyId: randomUUID(),
      expiresAt: this.refreshExpiry(),
      // Remembered so a refresh can restore it. Re-validated against live
      // memberships every time it is read back.
      activeCompanyId: input.activeCompanyId,
      ipAddress: input.meta.ipAddress,
      userAgent: input.meta.userAgent,
    });

    return {
      accessToken: this.tokens.signStaffAccess({
        userAccountId: input.userAccountId,
        sessionId: session.id,
        email: input.email,
        name: input.name,
        activeCompanyId: input.activeCompanyId,
        companyUserId: input.companyUserId,
      }),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds,
      activeCompanyId: input.activeCompanyId,
    };
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.config.auth.refreshTokenTtlDays * 86_400_000);
  }
}

function toSummary(m: {
  companyId: string;
  companySlug: string;
  companyName: string;
  isOwner: boolean;
}): MembershipSummary {
  return {
    companyId: m.companyId,
    companySlug: m.companySlug,
    companyName: m.companyName,
    isOwner: m.isOwner,
  };
}
