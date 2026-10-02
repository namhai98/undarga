import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { GiftCardsController } from './giftcards.controller';
import { GiftCardRepository, GiftCardsService } from './giftcards.service';

/**
 * Stored value.
 *
 * `AuthModule` is imported for `TokenHashService` — gift-card codes use the
 * same HMAC-with-a-server-pepper scheme as refresh tokens, which is what that
 * service was written for (its own comment says so). One hashing scheme, one
 * pepper, one place to rotate it.
 *
 * Exports the service because payments redeem cards INSIDE the payment
 * transaction: a redemption and the payment that consumed it must commit
 * together or not at all.
 */
@Module({
  imports: [DatabaseModule, AuthModule, NotificationsModule],
  controllers: [GiftCardsController],
  providers: [GiftCardsService, GiftCardRepository],
  exports: [GiftCardsService],
})
export class GiftCardsModule {}
