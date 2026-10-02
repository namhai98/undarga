import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { PaymentMethod } from '@prisma/client';
import type {
  ChargeOutcome,
  ChargeRequest,
  PaymentProvider,
  RefundOutcome,
  RefundRequest,
} from './payment-provider';

/**
 * The slot a real gateway goes into.
 *
 * ---------------------------------------------------------------------------
 * WHY A MOCK AND NOT "ONLINE IS JUST MANUAL FOR NOW"
 * ---------------------------------------------------------------------------
 *
 * Because an online charge has states manual money does not, and a codebase
 * that never exercises them grows call sites that assume success. This provider
 * produces an intent id, returns AUTHORIZED or SUCCEEDED, and can be made to
 * fail deterministically — so the service, the appointment projection and the
 * UI all get written against a payment that might not have settled yet.
 *
 * When QPay lands it implements this same interface, and the only thing that
 * changes is which provider the registry hands back for `ONLINE`.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISTIC, NOT RANDOM
 * ---------------------------------------------------------------------------
 *
 * A mock that fails 10% of the time at random makes a flaky test suite and
 * teaches nobody anything. This one keys off the amount: a charge whose minor
 * units end in `13` fails, and one whose metadata says `simulate: 'pending'`
 * stays pending. Both are reachable from a test and from a dev poking at
 * Swagger, and neither happens by accident.
 */
@Injectable()
export class MockOnlinePaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(MockOnlinePaymentProvider.name);

  readonly name = 'mock-online';
  readonly methods: readonly PaymentMethod[] = ['ONLINE'];

  charge(request: ChargeRequest): Promise<ChargeOutcome> {
    const intentId = reference('pi', request.idempotencyKey);

    if (request.amountMinor % 100n === 13n) {
      this.logger.warn(`Simulated decline for ${request.reference}`);
      return Promise.resolve({
        status: 'FAILED',
        provider: this.name,
        providerIntentId: intentId,
        failureReason: 'Simulated decline (amount ends in 13).',
      });
    }

    if (request.metadata?.simulate === 'pending') {
      return Promise.resolve({
        status: 'PENDING',
        provider: this.name,
        providerIntentId: intentId,
      });
    }

    if (request.metadata?.simulate === 'authorize') {
      return Promise.resolve({
        status: 'AUTHORIZED',
        provider: this.name,
        providerIntentId: intentId,
      });
    }

    return Promise.resolve({
      status: 'SUCCEEDED',
      provider: this.name,
      providerIntentId: intentId,
      providerChargeId: reference('ch', request.idempotencyKey),
      // A plausible gateway commission, so nothing downstream assumes fees are
      // always zero: 2.9% + 30 minor units, in integer arithmetic.
      feeMinor: (request.amountMinor * 29n) / 1000n + 30n,
    });
  }

  refund(request: RefundRequest): Promise<RefundOutcome> {
    if (!request.providerChargeId) {
      // A charge that never settled cannot be refunded — it is cancelled
      // instead. Saying so is better than pretending the refund worked.
      return Promise.resolve({
        status: 'FAILED',
        provider: this.name,
        failureReason: 'The original charge was never captured.',
      });
    }

    return Promise.resolve({
      status: 'SUCCEEDED',
      provider: this.name,
      providerRefundId: reference('re', request.idempotencyKey),
    });
  }
}

function reference(prefix: string, key: string): string {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}
