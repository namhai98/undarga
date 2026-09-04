import { Module } from '@nestjs/common';
import { ConfigModule } from '../config';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [ConfigModule, DatabaseModule, RedisModule, TenancyModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
