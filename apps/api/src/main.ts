import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap/configure-app';
import { createAppLogger } from './bootstrap/logger';
import { AppConfig } from './config';
import { setupSwagger } from './common/swagger/setup-swagger';

async function bootstrap(): Promise<void> {
  // rawBody: webhook signatures are computed over the exact bytes received
  // (req.rawBody); the parsed JSON is not the same thing.
  // bufferLogs: start-up lines wait for the configured logger (JSON in
  // production) instead of going out in the default format first.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const config = app.get(AppConfig);
  app.useLogger(createAppLogger(config));
  const logger = new Logger('bootstrap');

  // Security headers, trust proxy, CORS, prefix and versioning — shared with
  // the e2e harness so the tests run the same HTTP setup as production.
  configureApp(app, config);

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

  logger.log(
    `API listening on :${config.app.port}/${config.app.apiPrefix}/v1 [${config.app.nodeEnv}]`,
  );
  if (docsPath) logger.log(`OpenAPI docs at :${config.app.port}/${docsPath}`);
}

void bootstrap();
