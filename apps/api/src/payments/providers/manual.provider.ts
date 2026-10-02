import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PaymentMethod } from '@prisma/client';
import type {
  ChargeOutcome,
  ChargeRequest,
  PaymentProvider,
  RefundOutcome,
  RefundRequest,
} from './payment-provider';

/**
 * Money that moved outside this software.
 *
 * Cash in the drawer, a card terminal receipt, a bank transfer the owner has
 * already seen on their statement. The staff member is asserting a fact, so
 * there is nothing to authorise, nothing that can be declined, and no fee this
 * system knows about.
 *
 * It still goes through the provider interface rather than being special-cased
 * in the service, because the moment it is special-cased the service grows an
 * `if (method === CASH)` and every later gateway adds another branch to it.
 *
 * The reference id is derived from the idempotency key so a duplicate submit is
 * visibly the same receipt rather than a second one that happens to match.
 */
@Injectable()
export class ManualPaymentProvider implements PaymentProvider {
  readonly name = 'manual';

  readonly methods: readonly PaymentMethod[] = [
    'CASH',
    'CARD',
    'BANK_TRANSFER',
    'WALLET',
    'OTHER',
  ];

  charge(request: ChargeRequest): Promise<ChargeOutcome> {
    return Promise.resolve({
      status: 'SUCCEEDED',
      provider: this.name,
      providerChargeId: reference('chg', request.idempotencyKey),
      feeMinor: 0n,
    });
  }

  refund(request: RefundRequest): Promise<RefundOutcome> {
    // Handing cash back across the counter. The system records that it
    // happened; it did not make it happen.
    return Promise.resolve({
      status: 'SUCCEEDED',
      provider: this.name,
      providerRefundId: reference('rfd', request.idempotencyKey),
    });
  }
}

function reference(prefix: string, key: string): string {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}
