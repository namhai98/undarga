import { Logger, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import type { AppConfig } from '../config';

/**
 * The HTTP-level security setup, shared by `main.ts` and the e2e harness so
 * the tests exercise the same headers, CORS policy and proxy handling that
 * production runs.
 */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  const logger = new Logger('bootstrap');

  // The client address behind a load balancer. Without it every request
  // appears to come from the balancer, and per-IP limits lock out everyone.
  // See TRUST_PROXY in env.schema.ts.
  app.set('trust proxy', config.app.trustProxy);

  const hsts = config.app.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false;
  // A JSON API: no HTML is ever served, so the strictest policy costs nothing.
  const apiHeaders = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    strictTransportSecurity: hsts,
  });
  // The Swagger UI (off in production unless enabled) is an HTML page with
  // scripts and styles of its own; it gets helmet's standard policy.
  const docsHeaders = helmet({ strictTransportSecurity: hsts });
  const docsPrefix = `/${config.app.apiPrefix}/docs`;
  app.use((req: Request, res: Response, next: NextFunction) =>
    (req.path.startsWith(docsPrefix) ? docsHeaders : apiHeaders)(req, res, next),
  );
  // The browser must not cache authenticated responses (tokens, personal data).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(cookieOriginCheck(config));

  app.setGlobalPrefix(config.app.apiPrefix);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  /**
   * CORS is an explicit allow-list with no wildcard.
   *
   * `credentials: true` and `origin: '*'` are mutually exclusive in the browser
   * anyway, but the deeper reason is that this API will eventually serve
   * per-tenant custom domains — those origins get added once domain
   * verification exists, not blanket-allowed now. An empty list means
   * same-origin only, and production refuses to boot with one.
   */
  if (config.cors.enabled) {
    app.enableCors({
      origin: config.cors.origins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Company-Id',
        'X-Company-Slug',
        'X-Request-Id',
        'Idempotency-Key',
      ],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    });
    logger.log(`CORS enabled for: ${config.cors.origins.join(', ')}`);
  } else {
    logger.warn('CORS disabled (CORS_ORIGINS is empty) — same-origin requests only');
  }
}

/**
 * Cross-site request forgery defence for the endpoints a cookie authenticates.
 *
 * Everything else takes a bearer token, which a browser never attaches on its
 * own. The refresh cookie is SameSite=Lax, which already stops cross-SITE
 * posts; this also stops a sibling subdomain or any other origin from driving
 * refresh/logout. A browser always sends Origin on a cross-origin POST, so a
 * request that names an origin outside CORS_ORIGINS is refused. No Origin
 * (server-to-server, curl) is allowed: it carries no browser cookie by accident.
 */
function cookieOriginCheck(config: AppConfig) {
  const allowed = new Set(config.cors.origins);
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST' || !/\/auth\/(?:[^/]+\/)?(?:refresh|logout)$/.test(req.path))
      return next();
    const origin = req.headers.origin;
    if (!origin || allowed.has(origin) || isSameOrigin(req, origin)) return next();
    res.status(403).json({
      error: {
        code: 'PERMISSION_DENIED',
        message: 'This request did not come from an allowed origin.',
        requestId: (req as Request & { requestId?: string }).requestId,
      },
    });
  };
}

function isSameOrigin(req: Request, origin: string): boolean {
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
