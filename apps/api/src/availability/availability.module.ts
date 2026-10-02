import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AvailabilityController } from './availability.controller';
import { AvailabilityRepository } from './availability.repository';
import { AvailabilityService } from './availability.service';

/**
 * The availability engine.
 *
 * Owns no tables of its own — it reads branch hours, schedules, the catalogue,
 * resources and appointments through one repository that keeps every query
 * tenant-scoped (docs/ARCHITECTURE-RULES.md rule 5: a module never reaches for
 * another module's tables directly, but the read path here is deliberately one
 * place rather than a call fan-out per row type, because availability is a
 * single cohesive query the hot-path indexes were built for).
 *
 * `RedisModule` is global, so the short advisory cache needs no import here.
 * Exports the service so a future public booking controller can call the exact
 * same engine (docs prompt §29).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AvailabilityController],
  providers: [AvailabilityService, AvailabilityRepository],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
