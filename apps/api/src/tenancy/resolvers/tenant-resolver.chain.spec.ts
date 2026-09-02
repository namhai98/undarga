import { AmbiguousTenantError } from '../../common/errors';
import type { TenantDirectoryService } from '../directory/tenant-directory.service';
import { TenantResolverChain } from './tenant-resolver.chain';
import type {
  TenantCandidate,
  TenantResolutionInput,
  TenantResolver,
} from './tenant-resolver.types';

const COMPANY_A = '018f0000-0000-7000-8000-00000000000a';
const COMPANY_B = '018f0000-0000-7000-8000-00000000000b';

function stubResolver(
  name: string,
  priority: number,
  candidate: TenantCandidate | null,
  enabled = true,
): TenantResolver {
  return {
    name,
    priority,
    isEnabled: () => enabled,
    resolve: () => candidate,
  };
}

function directoryStub(slugs: Record<string, string> = {}): TenantDirectoryService {
  return {
    findCompanyIdBySlug: async (slug: string) => slugs[slug] ?? null,
  } as unknown as TenantDirectoryService;
}

const input: TenantResolutionInput = {
  params: {},
  query: {},
  headers: {},
  path: '/api/v1/appointments',
  method: 'GET',
  actor: null,
};

describe('TenantResolverChain', () => {
  it('returns null when nothing names a company', async () => {
    const chain = new TenantResolverChain([stubResolver('none', 10, null)], directoryStub());
    await expect(chain.resolve(input)).resolves.toBeNull();
  });

  it('skips disabled resolvers entirely', async () => {
    // Custom domain and subdomain ship disabled; a disabled resolver must not
    // contribute a candidate even if it would have matched.
    const chain = new TenantResolverChain(
      [
        stubResolver(
          'custom-domain',
          40,
          { source: 'CUSTOM_DOMAIN', explicit: true, companyId: COMPANY_B },
          false,
        ),
        stubResolver('active-company-claim', 20, {
          source: 'ACTIVE_COMPANY_CLAIM',
          explicit: false,
          companyId: COMPANY_A,
        }),
      ],
      directoryStub(),
    );

    const result = await chain.resolve(input);
    expect(result?.companyId).toBe(COMPANY_A);
    expect(result?.source).toBe('ACTIVE_COMPANY_CLAIM');
  });

  describe('explicit beats implicit', () => {
    // This is what makes /companies/:companyId/... work for a user who belongs
    // to several companies without switching first. It is only safe because
    // "wins" means "gets membership-checked", not "gets access".
    it('prefers a route parameter over the session active company', async () => {
      const chain = new TenantResolverChain(
        [
          stubResolver('route-param', 10, {
            source: 'ROUTE_PARAM',
            explicit: true,
            companyId: COMPANY_B,
          }),
          stubResolver('active-company-claim', 20, {
            source: 'ACTIVE_COMPANY_CLAIM',
            explicit: false,
            companyId: COMPANY_A,
          }),
        ],
        directoryStub(),
      );

      const result = await chain.resolve(input);
      expect(result?.companyId).toBe(COMPANY_B);
      expect(result?.explicit).toBe(true);
    });
  });

  describe('ambiguity', () => {
    // Precedence between two explicit channels would be a confused-deputy
    // generator: an attacker who can influence one but not the other gets to
    // steer the request. So it is always a hard failure.
    it('refuses when two explicit sources disagree', async () => {
      const chain = new TenantResolverChain(
        [
          stubResolver('route-param', 10, {
            source: 'ROUTE_PARAM',
            explicit: true,
            companyId: COMPANY_A,
          }),
          stubResolver('header', 30, {
            source: 'HEADER',
            explicit: true,
            companyId: COMPANY_B,
          }),
        ],
        directoryStub(),
      );

      await expect(chain.resolve(input)).rejects.toThrow(AmbiguousTenantError);
    });

    it('accepts two explicit sources that agree', async () => {
      const chain = new TenantResolverChain(
        [
          stubResolver('route-param', 10, {
            source: 'ROUTE_PARAM',
            explicit: true,
            companyId: COMPANY_A,
          }),
          stubResolver('header', 30, {
            source: 'HEADER',
            explicit: true,
            companyId: COMPANY_A,
          }),
        ],
        directoryStub(),
      );

      const result = await chain.resolve(input);
      expect(result?.companyId).toBe(COMPANY_A);
      expect(result?.matchedBy).toEqual(['route-param', 'header']);
    });

    it('does not treat a slug and an id for the same company as a conflict', async () => {
      // Normalisation happens before comparison, otherwise /c/acme with an
      // X-Company-Id header for the same company would 400.
      const chain = new TenantResolverChain(
        [
          stubResolver('route-param', 10, {
            source: 'ROUTE_PARAM',
            explicit: true,
            companySlug: 'acme',
          }),
          stubResolver('header', 30, {
            source: 'HEADER',
            explicit: true,
            companyId: COMPANY_A,
          }),
        ],
        directoryStub({ acme: COMPANY_A }),
      );

      const result = await chain.resolve(input);
      expect(result?.companyId).toBe(COMPANY_A);
    });
  });

  it('resolves a slug through the directory', async () => {
    const chain = new TenantResolverChain(
      [stubResolver('subdomain', 50, { source: 'SUBDOMAIN', explicit: true, companySlug: 'acme' })],
      directoryStub({ acme: COMPANY_A }),
    );

    const result = await chain.resolve(input);
    expect(result?.companyId).toBe(COMPANY_A);
    expect(result?.source).toBe('SUBDOMAIN');
  });

  it('returns null for a slug that matches no company', async () => {
    // "Unresolved" rather than "not found": a bad slug must not be usable to
    // probe which slugs exist.
    const chain = new TenantResolverChain(
      [
        stubResolver('subdomain', 50, {
          source: 'SUBDOMAIN',
          explicit: true,
          companySlug: 'does-not-exist',
        }),
      ],
      directoryStub({ acme: COMPANY_A }),
    );

    await expect(chain.resolve(input)).resolves.toBeNull();
  });

  it('reports which strategies are enabled', () => {
    const chain = new TenantResolverChain(
      [
        stubResolver('route-param', 10, null, true),
        stubResolver('custom-domain', 40, null, false),
        stubResolver('header', 30, null, true),
      ],
      directoryStub(),
    );

    expect(chain.enabledResolvers()).toEqual(['route-param', 'header']);
  });
});
