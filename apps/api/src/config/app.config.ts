import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * Typed accessor over validated env. Nothing in the codebase reads
 * `process.env` directly — that is what lets `validateEnv` be the single place
 * a misconfiguration is caught.
 */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true }) as Env[K];
  }

  get nodeEnv() { return this.get('NODE_ENV'); }
  get isProduction() { return this.get('NODE_ENV') === 'production'; }
  get isTest() { return this.get('NODE_ENV') === 'test'; }
  get port() { return this.get('PORT'); }
  get apiPrefix() { return this.get('API_PREFIX'); }
  get logLevel() { return this.get('LOG_LEVEL'); }

  get databaseUrl() { return this.get('DATABASE_URL'); }
  get platformDatabaseUrl() { return this.get('PLATFORM_DATABASE_URL'); }
  get poolingMode() { return this.get('DB_POOLING_MODE'); }

  get jwtAccessSecret() { return this.get('JWT_ACCESS_SECRET'); }
  get jwtAccessTtlSeconds() { return this.get('JWT_ACCESS_TTL_SECONDS'); }
  get refreshTokenTtlDays() { return this.get('REFRESH_TOKEN_TTL_DAYS'); }
  get tokenHashPepper() { return this.get('TOKEN_HASH_PEPPER'); }

  get argon2Options() {
    return {
      memoryCost: this.get('ARGON2_MEMORY_KIB'),
      timeCost: this.get('ARGON2_TIME_COST'),
      parallelism: this.get('ARGON2_PARALLELISM'),
    };
  }

  get tenantResolvers() {
    return {
      routeParam: this.get('TENANT_RESOLVER_ROUTE_PARAM'),
      activeCompany: this.get('TENANT_RESOLVER_ACTIVE_COMPANY'),
      header: this.get('TENANT_RESOLVER_HEADER'),
      customDomain: this.get('TENANT_RESOLVER_CUSTOM_DOMAIN'),
      subdomain: this.get('TENANT_RESOLVER_SUBDOMAIN'),
    };
  }

  get subdomainRoot() { return this.get('TENANT_SUBDOMAIN_ROOT'); }
  get tenantCacheTtlSeconds() { return this.get('TENANT_CACHE_TTL_SECONDS'); }
  get auditHashChain() { return this.get('AUDIT_HASH_CHAIN'); }
  get redisUrl() { return this.get('REDIS_URL'); }
}
