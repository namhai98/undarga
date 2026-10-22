import { Module } from '@nestjs/common';
import { AppConfig } from '../config';
import { DatabaseModule } from '../database/database.module';
import { GiftCardsModule } from '../giftcards/giftcards.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { paymentGatewayProviders } from './gateway/payment-gateway';
import {
  InvoicePaymentsController,
  OnlinePaymentsController,
  PaymentWebhooksController,
  PlatformPaymentsController,
  PublicPaymentsController,
} from './online-payments.controller';
import { PaymentPlatformRepository } from './payment-platform.repository';
import { PaymentTransactionsService } from './payment-transactions.service';
import { PaymentWebhooksService } from './payment-webhooks.service';
import { PaymentsController } from './payments.controller';
import { PaymentRepository, PaymentsService } from './payments.service';
import { ManualPaymentProvider } from './providers/manual.provider';
import { MockOnlinePaymentProvider } from './providers/mock-online.provider';
import { PAYMENT_PROVIDERS } from './providers/payment-provider';
import { PaymentProviderRegistry } from './providers/provider.registry';

/**
 * Payments: money recorded at the till (`providers/`, PaymentsService) and
 * money taken online through a gateway (`gateway/`, PaymentTransactionsService,
 * webhooks). See docs/PAYMENTS.md.
 *
 * The synchronous `mock-online` recorder predates the gateway and lets staff
 * record a simulated ONLINE charge in development. It is left out in
 * production, where an ONLINE payment can only come from a real provider.
 */
@Module({
  imports: [DatabaseModule, GiftCardsModule, NotificationsModule],
  controllers: [
    PaymentsController,
    OnlinePaymentsController,
    InvoicePaymentsController,
    PublicPaymentsController,
    PaymentWebhooksController,
    PlatformPaymentsController,
  ],
  providers: [
    PaymentsService,
    PaymentRepository,
    PaymentProviderRegistry,
    ManualPaymentProvider,
    MockOnlinePaymentProvider,
    {
      provide: PAYMENT_PROVIDERS,
      useFactory: (
        config: AppConfig,
        manual: ManualPaymentProvider,
        online: MockOnlinePaymentProvider,
      ) => (config.app.isProduction ? [manual] : [manual, online]),
      inject: [AppConfig, ManualPaymentProvider, MockOnlinePaymentProvider],
    },
    ...paymentGatewayProviders,
    PaymentTransactionsService,
    PaymentWebhooksService,
    PaymentPlatformRepository,
  ],
  exports: [PaymentsService, PaymentTransactionsService],
})
export class PaymentsModule {}
