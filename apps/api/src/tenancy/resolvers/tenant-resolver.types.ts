import type { Actor, TenantResolutionSource } from '../context/context.types';

/**
 * A transport-neutral view of "the incoming thing".
 *
 * Deliberately not an Express Request. The same resolver chain has to work for
 * HTTP today and for WebSocket handshakes later, and neither should have to
 * know about the other. Adapters live at the edge (see TenantGuard).
 */
export interface TenantResolutionInput {
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly host?: string;
  readonly path: string;
  readonly method: string;
  /** null when the request has not authenticated. */
  readonly actor: Actor | null;
  /**
   * The `act` (active company) claim from the *already signature-verified*
   * access token, if any.
   *
   * Passed as its own field rather than read out of a header so that it cannot
   * be forged: only JwtAuthGuard, holding a verified token, populates it.
   */
  readonly activeCompanyId?: string;
}

/**
 * A *claim* about which company the request concerns.
 *
 * The single most important thing in this file: a candidate is not permission.
 * Resolvers answer "which company is being named?" and nothing else. Whether
 * the actor may enter that company is decided later and elsewhere, by
 * MembershipService. Keeping those two jobs in separate objects is what stops
 * "the client sent companyId, so we used companyId".
 */
export interface TenantCandidate {
  readonly source: TenantResolutionSource;
  /**
   * True when the caller named the company (URL, header, hostname); false when
   * it came from their own session's active company.
   *
   * Two *explicit* candidates that disagree is a hard error. An explicit
   * candidate overriding an implicit one is normal and expected — that is how
   * `/companies/:companyId/...` works for a multi-company user.
   */
  readonly explicit: boolean;
  readonly companyId?: string;
  readonly companySlug?: string;
  readonly hostname?: string;
}

export interface TenantResolver {
  /** Stable name, used in ambiguity errors and audit metadata. */
  readonly name: string;
  /** Lower runs first. Only used for deterministic ordering, not precedence. */
  readonly priority: number;
  /** Config-gated. A disabled resolver is skipped entirely. */
  isEnabled(): boolean;
  resolve(input: TenantResolutionInput): Promise<TenantCandidate | null> | TenantCandidate | null;
}

/** DI token for the resolver chain's members. */
export const TENANT_RESOLVER = Symbol('TENANT_RESOLVER');
