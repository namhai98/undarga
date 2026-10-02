import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { GiftCardsModule } from '../giftcards/giftcards.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsController } from './payments.controller';
import { PaymentRepository, PaymentsService } from './payments.service';
import { ManualPaymentProvider } from './providers/manual.provider';
import { MockOnlinePaymentProvider } from './providers/mock-online.provider';
import { PAYMENT_PROVIDERS } from './providers/payment-provider';
import { PaymentProviderRegistry } from './providers/provider.registry';

/**
 * Money in and money back out.
 *
 * ---------------------------------------------------------------------------
 * WHY GiftCardsModule IS AN IMPORT AND NOT A COPY
 * ---------------------------------------------------------------------------
 *
 * A gift-card payment draws the card down INSIDE the payment transaction. That
 * needs the real service, not a re-implementation: the balance check, the
 * `FOR UPDATE` lock and the append-only ledger row all have to be the same code
 * the gift-card endpoints use, or the two paths drift and one of them is wrong.
 *
 * ---------------------------------------------------------------------------
 * ADDING QPAY
 * ---------------------------------------------------------------------------
 *
 * Write a class implementing `PaymentProvider`, add it to the array below, and
 * remove `MockOnlinePaymentProvider`. The registry refuses to start if both
 * claim `ONLINE`, which is deliberate — silently routing half the payments to a
 * stub is the failure this prevents.
 */
@Module({
  imports: [DatabaseModule, GiftCardsModule, NotificationsModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentRepository,
    PaymentProviderRegistry,
    ManualPaymentProvider,
    MockOnlinePaymentProvider,
    {
      provide: PAYMENT_PROVIDERS,
      useFactory: (manual: ManualPaymentProvider, online: MockOnlinePaymentProvider) => [
        manual,
        online,
      ],
      inject: [ManualPaymentProvider, MockOnlinePaymentProvider],
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
