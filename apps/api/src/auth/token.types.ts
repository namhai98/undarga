/**
 * Token shapes.
 *
 * ---------------------------------------------------------------------------
 * THREE REALMS, THREE AUDIENCES
 * ---------------------------------------------------------------------------
 *
 * Staff, platform operators and customers get tokens with different `aud`
 * values, and every guard checks the audience before anything else. A customer
 * token presented to a staff endpoint is rejected on that basis alone — no
 * permission lookup, no membership check, no chance for a subtle bug in either
 * to matter.
 *
 * This costs one claim and removes an entire class of escalation.
 */

export type TokenRealm = 'staff' | 'platform' | 'customer';

interface BaseClaims {
  /** Subject: userAccountId, platformUserId, or customerIdentityId. */
  sub: string;
  aud: TokenRealm;
  /** Session id, matched against the deny-list on every request. */
  sid: string;
  jti: string;
  iat: number;
  exp: number;
  email: string;
  name: string;
}

export interface StaffAccessClaims extends BaseClaims {
  aud: 'staff';
  /**
   * Active company id.
   *
   * A hint, never an authorization. TenantGuard re-validates it against
   * `company_user` on every request, so revoking a membership takes effect
   * within one access-token lifetime at worst — and immediately for any company
   * the user was not already inside.
   *
   * Absent for a user who has not selected a company yet (a fresh account, or
   * one whose only membership was just revoked).
   */
  act?: string;
  /** companyUserId for the active company, cached to save one lookup. */
  cu?: string;
}

export interface PlatformAccessClaims extends BaseClaims {
  aud: 'platform';
  /**
   * Platform permissions are deliberately NOT in the token. They are the
   * highest-privilege grants in the system, so they are re-read per request
   * (behind a short cache) and revoking one takes effect in seconds rather
   * than at the next token refresh.
   */
  /** Active impersonation grant, if the operator started one. */
  imp?: {
    /** grant id */ g: string;
    /** company id */ c: string;
    /** allow writes */ w: boolean;
    /** expiry, epoch seconds */ e: number;
  };
}

export interface CustomerAccessClaims extends BaseClaims {
  aud: 'customer';
  /** Customer tokens are minted for exactly one company and cannot move. */
  act: string;
  /** companyCustomerId */
  cc: string;
}

export type AccessClaims = StaffAccessClaims | PlatformAccessClaims | CustomerAccessClaims;

export interface IssuedTokens {
  accessToken: string;
  /** Opaque, 256-bit. Only its HMAC is stored. */
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  activeCompanyId?: string;
}
