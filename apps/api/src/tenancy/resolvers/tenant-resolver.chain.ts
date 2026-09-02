import { Inject, Injectable, Logger } from '@nestjs/common';
import { AmbiguousTenantError } from '../../common/errors';
import { TenantDirectoryService } from '../directory/tenant-directory.service';
import type { TenantResolutionSource } from '../context/context.types';
import {
  TENANT_RESOLVER,
  type TenantCandidate,
  type TenantResolutionInput,
  type TenantResolver,
} from './tenant-resolver.types';

export interface ResolvedTenantCandidate {
  readonly companyId: string;
  readonly source: TenantResolutionSource;
  readonly explicit: boolean;
  /** Every strategy that named this company, for audit metadata. */
  readonly matchedBy: readonly string[];
}

/**
 * Runs the resolver chain and arbitrates between what comes back.
 *
 * The arbitration rules are the interesting part, and each exists to close a
 * specific hole:
 *
 *   EXPLICIT BEATS IMPLICIT
 *     A company named in the URL wins over the session's active company. This
 *     is what makes `/companies/:companyId/...` work for someone who belongs to
 *     three companies without forcing them to switch first. It is safe only
 *     because winning here means "gets checked", not "gets access".
 *
 *   TWO DISAGREEING EXPLICIT SOURCES IS A HARD FAILURE
 *     If the URL says company A and X-Company-Id says company B, there is no
 *     defensible way to pick. Precedence rules here would be a confused-deputy
 *     generator: an attacker who can influence one channel but not the other
 *     gets to steer the request. So: 400, always.
 *
 *   NOTHING IS EVER GUESSED
 *     No candidate means no tenant. The chain returns null and the caller
 *     decides whether that route tolerates it. There is no "fall back to the
 *     user's first membership".
 */
@Injectable()
export class TenantResolverChain {
  private readonly logger = new Logger(TenantResolverChain.name);
  private readonly resolvers: readonly TenantResolver[];

  constructor(
    @Inject(TENANT_RESOLVER) resolvers: TenantResolver[],
    private readonly directory: TenantDirectoryService,
  ) {
    this.resolvers = [...resolvers].sort((a, b) => a.priority - b.priority);
  }

  /** Names of the currently enabled strategies. Surfaced on the health route. */
  enabledResolvers(): string[] {
    return this.resolvers.filter((r) => r.isEnabled()).map((r) => r.name);
  }

  async resolve(input: TenantResolutionInput): Promise<ResolvedTenantCandidate | null> {
    const candidates: Array<{ resolver: TenantResolver; candidate: TenantCandidate }> = [];

    for (const resolver of this.resolvers) {
      if (!resolver.isEnabled()) continue;
      const candidate = await resolver.resolve(input);
      if (candidate) candidates.push({ resolver, candidate });
    }

    if (candidates.length === 0) return null;

    // Normalise every candidate to a company id before comparing. A slug and a
    // uuid naming the same company must not read as a conflict.
    const normalised: Array<{
      name: string;
      companyId: string | null;
      candidate: TenantCandidate;
    }> = [];

    for (const { resolver, candidate } of candidates) {
      normalised.push({
        name: resolver.name,
        companyId: await this.toCompanyId(candidate),
        candidate,
      });
    }

    const explicit = normalised.filter((n) => n.candidate.explicit && n.companyId);
    const implicit = normalised.filter((n) => !n.candidate.explicit && n.companyId);

    if (explicit.length > 0) {
      const distinct = new Set(explicit.map((e) => e.companyId));
      if (distinct.size > 1) {
        throw new AmbiguousTenantError(
          explicit.map((e) => `${e.name}=${e.candidate.companyId ?? e.candidate.companySlug}`),
        );
      }
      const winner = explicit[0]!;
      return {
        companyId: winner.companyId!,
        source: winner.candidate.source,
        explicit: true,
        matchedBy: explicit.map((e) => e.name),
      };
    }

    if (implicit.length > 0) {
      // Implicit sources cannot realistically conflict (there is one token),
      // but if they ever do, refuse rather than pick.
      const distinct = new Set(implicit.map((i) => i.companyId));
      if (distinct.size > 1) {
        throw new AmbiguousTenantError(implicit.map((i) => i.name));
      }
      const winner = implicit[0]!;
      return {
        companyId: winner.companyId!,
        source: winner.candidate.source,
        explicit: false,
        matchedBy: implicit.map((i) => i.name),
      };
    }

    // Something was named but does not correspond to a real company. Treated as
    // "unresolved" rather than "not found" so that a bad slug in the URL cannot
    // be used to probe which slugs exist.
    this.logger.debug(
      `No candidate resolved to a company for ${input.method} ${input.path} ` +
        `(tried: ${normalised.map((n) => n.name).join(', ')})`,
    );
    return null;
  }

  private async toCompanyId(candidate: TenantCandidate): Promise<string | null> {
    if (candidate.companyId) return candidate.companyId;
    if (candidate.companySlug) {
      return this.directory.findCompanyIdBySlug(candidate.companySlug);
    }
    return null;
  }
}
