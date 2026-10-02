import { Inject, Injectable } from '@nestjs/common';
import type { PaymentMethod } from '@prisma/client';
import { ValidationFailedError } from '../../common/errors';
import { PAYMENT_PROVIDERS, type PaymentProvider } from './payment-provider';

/**
 * Which provider handles which method.
 *
 * Built once at construction and then read-only, so a method claimed by two
 * providers is a startup failure rather than a coin flip at charge time. That
 * matters when a real gateway is added: registering QPay for `ONLINE` while the
 * mock is still registered should stop the process, not silently route half the
 * payments to a stub.
 *
 * `GIFT_CARD` is deliberately absent. Redeeming stored value is not a charge —
 * no money enters the business, a liability the company already owes is drawn
 * down instead. It is handled inside the payment transaction by the gift-card
 * service, and asking a "provider" to do it would put a ledger write behind an
 * interface designed for remote calls.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly byMethod = new Map<PaymentMethod, PaymentProvider>();

  constructor(@Inject(PAYMENT_PROVIDERS) providers: readonly PaymentProvider[]) {
    for (const provider of providers) {
      for (const method of provider.methods) {
        const existing = this.byMethod.get(method);
        if (existing) {
          throw new Error(
            `Payment method ${method} is claimed by both "${existing.name}" and ` +
              `"${provider.name}". Remove one before starting.`,
          );
        }
        this.byMethod.set(method, provider);
      }
    }
  }

  /** @throws ValidationFailedError when nothing can handle the method. */
  forMethod(method: PaymentMethod): PaymentProvider {
    const provider = this.byMethod.get(method);
    if (!provider) {
      throw new ValidationFailedError({
        method: `No payment provider is configured for ${method}.`,
      });
    }
    return provider;
  }

  /** By stored name, for refunding through whatever took the original charge. */
  byName(name: string): PaymentProvider | null {
    for (const provider of this.byMethod.values()) {
      if (provider.name === name) return provider;
    }
    return null;
  }
}
