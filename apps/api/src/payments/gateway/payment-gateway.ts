import { Inject, Injectable, type Provider } from '@nestjs/common';
import { PaymentsUnavailableError } from '../../common/errors';
import { AppConfig } from '../../config';
import { MockPaymentProvider } from './mock.provider';
import { PAYMENT_GATEWAY_PROVIDERS, type PaymentProvider } from './payment-provider';
import { PaymentSigner } from './payment-signer';
import { QPayProvider } from './qpay.provider';

/**
 * The configured online-payment provider, and lookup by stored name.
 *
 * Exactly one provider takes NEW payments (`PAYMENT_PROVIDER`). Existing
 * transactions are always refunded and checked through the provider that took
 * them — `byName` — never through whichever is configured today.
 */
@Injectable()
export class PaymentGateway {
  constructor(
    @Inject(PAYMENT_GATEWAY_PROVIDERS) private readonly providers: readonly PaymentProvider[],
  ) {}

  /** Whether online payments can be taken at all. */
  get enabled(): boolean {
    return this.providers.length > 0;
  }

  /** The provider for new payments. */
  active(): PaymentProvider {
    const provider = this.providers[0];
    if (!provider) throw new PaymentsUnavailableError();
    return provider;
  }

  byName(name: string | null | undefined): PaymentProvider | null {
    if (!name) return null;
    return this.providers.find((p) => p.name === name) ?? null;
  }

  /** True when a stored `provider` value belongs to an online gateway. */
  isGatewayProvider(name: string | null | undefined): boolean {
    return this.byName(name) !== null;
  }
}

/**
 * Providers for PaymentsModule: the signer and the gateway list, both built
 * from AppConfig. A test overrides `PAYMENT_GATEWAY_PROVIDERS` and
 * `PaymentSigner` to run against a mock with a known secret.
 */
export const paymentGatewayProviders: Provider[] = [
  {
    provide: PaymentSigner,
    useFactory: (config: AppConfig) =>
      new PaymentSigner(config.payments.signingSecret, config.payments.webhookBaseUrl),
    inject: [AppConfig],
  },
  {
    provide: PAYMENT_GATEWAY_PROVIDERS,
    useFactory: (config: AppConfig, signer: PaymentSigner): PaymentProvider[] => {
      const payments = config.payments;
      switch (payments.provider) {
        case 'qpay':
          // env validation has already required every value used here.
          return [
            new QPayProvider(
              {
                baseUrl: payments.qpay.baseUrl,
                clientId: payments.qpay.clientId!,
                clientSecret: payments.qpay.clientSecret!,
                invoiceCode: payments.qpay.invoiceCode!,
              },
              signer,
            ),
          ];
        case 'mock':
          // Never in production: env validation refuses PAYMENT_PROVIDER=mock there.
          return [new MockPaymentProvider(signer.sign('mock-webhook', 'key'))];
        default:
          return [];
      }
    },
    inject: [AppConfig, PaymentSigner],
  },
  PaymentGateway,
];
