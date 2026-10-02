import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { PromotionsController } from './promotions.controller';
import { PromotionRepository, PromotionsService } from './promotions.service';

/**
 * Promotions and discounts.
 *
 * Imports AuthModule for TokenHashService: promotion codes are looked up by
 * keyed hash, the same scheme gift-card codes use. Exports the service so the
 * Appointment Engine can apply a code inside its own booking transaction.
 */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [PromotionsController],
  providers: [PromotionsService, PromotionRepository],
  exports: [PromotionsService],
})
export class PromotionsModule {}
