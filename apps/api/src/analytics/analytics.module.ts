import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsScopeService } from './analytics-scope';
import { AnalyticsRepository, AnalyticsService } from './analytics.service';
import { ReportsService } from './reports.service';

/**
 * Read-only aggregation over what the other modules wrote.
 *
 * It reads the appointment, payment, customer and gift-card tables directly,
 * which is the one place rule 5 is knowingly relaxed: a reporting layer that
 * had to ask five services for their numbers and join them in memory would be
 * exactly the row-scanning this module exists to avoid. It writes nothing, so
 * the coupling is one-way and a schema change breaks a query rather than
 * corrupting data.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsRepository, ReportsService, AnalyticsScopeService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
