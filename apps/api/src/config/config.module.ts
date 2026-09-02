import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfig } from './app.config';
import { validateEnv } from './env.schema';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Root .env so the API and any future app share one file.
      envFilePath: ['../../.env', '.env'],
      validate: validateEnv,
    }),
  ],
  providers: [AppConfig],
  exports: [AppConfig],
})
export class ConfigModule {}
