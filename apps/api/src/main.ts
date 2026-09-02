import 'reflect-metadata';
import { Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig } from './config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(AppConfig);
  const logger = new Logger('bootstrap');

  app.use(helmet());
  app.setGlobalPrefix(config.apiPrefix);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();

  // CORS is intentionally NOT configured with a wildcard. Allowed origins are
  // per-tenant (custom domains) and belong with the domain verification work,
  // so until that exists the API is same-origin only.

  await app.listen(config.port);
  logger.log(`API listening on :${config.port}/${config.apiPrefix}/v1 [${config.nodeEnv}]`);
}

void bootstrap();
