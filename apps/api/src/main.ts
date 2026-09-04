import 'reflect-metadata';
import { Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig } from './config';
import { setupSwagger } from './common/swagger/setup-swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(AppConfig);
  const logger = new Logger('bootstrap');

  app.use(helmet());
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
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Company-Id', 'X-Company-Slug', 'X-Request-Id', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    });
    logger.log(`CORS enabled for: ${config.cors.origins.join(', ')}`);
  } else {
    logger.warn('CORS disabled (CORS_ORIGINS is empty) — same-origin requests only');
  }

  /**
   * Graceful shutdown.
   *
   * Nest calls onModuleDestroy on SIGTERM, which is what lets Prisma drain its
   * pool and ioredis flush in-flight commands instead of dropping them. Without
   * this, a rolling deploy severs open transactions mid-flight.
   */
  app.enableShutdownHooks();

  const docsPath = setupSwagger(app, config);

  await app.listen(config.app.port);

  logger.log(`API listening on :${config.app.port}/${config.app.apiPrefix}/v1 [${config.app.nodeEnv}]`);
  if (docsPath) logger.log(`OpenAPI docs at :${config.app.port}/${docsPath}`);
}

void bootstrap();
