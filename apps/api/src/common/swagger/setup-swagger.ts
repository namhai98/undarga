import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import type { AppConfig } from '../../config';

/**
 * OpenAPI document and Swagger UI.
 *
 * ---------------------------------------------------------------------------
 * WHY nestjs-zod RATHER THAN class-validator
 * ---------------------------------------------------------------------------
 *
 * `@nestjs/swagger` traditionally derives schemas from `class-validator`
 * decorators. This codebase validates with zod — chosen so the same schema can
 * be shared with the frontend through `@undarga/shared`. Installing
 * class-validator purely to feed Swagger would mean two validation libraries,
 * two sources of truth, and inevitable drift between what the API rejects and
 * what the docs claim it accepts.
 *
 * Swagger 11 reads zod schemas natively when a DTO is built with
 * `createZodDto`; `cleanupOpenApiDoc` then strips the internal artefacts that
 * leaves behind. (nestjs-zod v4's `patchNestJsSwagger()` is gone — v5 replaced
 * it with this post-processing step.) The documented contract is therefore the
 * enforced one by construction.
 *
 * ---------------------------------------------------------------------------
 * DISABLED IN PRODUCTION BY DEFAULT
 * ---------------------------------------------------------------------------
 *
 * The document enumerates every route, parameter and error code — a free map
 * for anyone probing the API. `SWAGGER_ENABLED` defaults on for development and
 * should be off in production unless the API is deliberately public.
 */
export function setupSwagger(app: INestApplication, config: AppConfig): string | null {
  if (!config.app.swaggerEnabled) return null;

  const builder = new DocumentBuilder()
    .setTitle('Undarga Booking Platform API')
    .setDescription(
      [
        'Multi-tenant SaaS booking platform.',
        '',
        '**Tenancy.** Every company-scoped endpoint resolves its company from, in order of',
        'precedence: a `companyId` / `companySlug` path parameter, the `X-Company-Id` or',
        '`X-Company-Slug` header, then the active company in your access token. Two',
        'explicit sources naming different companies is a 400, never a guess.',
        '',
        '**Responses.** Success is `{ "data": ..., "meta": { "requestId": "..." } }`.',
        'Errors are `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`.',
        '',
        '**Not found vs forbidden.** Another company\'s record returns 404, never 403 —',
        'a 403 would confirm the record exists.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token' },
      'access-token',
    )
    .addGlobalParameters({
      name: 'X-Company-Id',
      in: 'header',
      required: false,
      description: 'Target company. Validated against your memberships; a non-member gets 404.',
      schema: { type: 'string', format: 'uuid' },
    })
    .addTag('health', 'Liveness and readiness probes')
    .addTag('auth', 'Sign-in, token refresh, and active-company selection');

  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, builder.build()));
  const path = `${config.app.apiPrefix}/docs`;

  SwaggerModule.setup(path, app, document, {
    swaggerOptions: { persistAuthorization: true },
    customSiteTitle: 'Undarga API',
  });

  return path;
}
