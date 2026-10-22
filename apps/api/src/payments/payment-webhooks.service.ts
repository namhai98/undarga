import { Injectable, Logger } from '@nestjs/common';
import { ResourceNotFoundError, WebhookSignatureInvalidError } from '../common/errors';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { PaymentGateway } from './gateway/payment-gateway';
import type { WebhookRequest } from './gateway/payment-provider';
import { PaymentPlatformRepository } from './payment-platform.repository';
import { PaymentTransactionsService } from './payment-transactions.service';

/**
 * ===========================================================================
 * INBOUND WEBHOOKS
 * ===========================================================================
 *
 *   1. verify      the provider checks its own signature (or, for QPay, ours on
 *                  the callback URL). Invalid: recorded as REJECTED, answered
 *                  401, nothing else happens.
 *   2. resolve     which transaction — and so which company — it concerns, by
 *                  an id the delivery had to sign.
 *   3. dedupe      (provider, eventKey) is unique. A redelivery of an event
 *                  already PROCESSED does nothing; one that did not change
 *                  anything last time is tried again.
 *   4. sync        the payment's state is READ BACK FROM THE PROVIDER and
 *                  applied under a row lock (PaymentTransactionsService). The
 *                  webhook body is never the source of truth — it is a nudge.
 *
 * A failure in step 4 answers 5xx so the provider retries; the event row says
 * FAILED with the reason, for whoever is debugging.
 */
@Injectable()
export class PaymentWebhooksService {
  private readonly logger = new Logger(PaymentWebhooksService.name);

  constructor(
    private readonly gateway: PaymentGateway,
    private readonly repository: PaymentPlatformRepository,
    private readonly transactions: PaymentTransactionsService,
    private readonly context: RequestContextService,
  ) {}

  async handle(providerName: string, request: WebhookRequest) {
    const provider = this.gateway.byName(providerName);
    if (!provider) throw new ResourceNotFoundError('PaymentProvider', providerName);

    const verified = provider.verifyWebhook(request);
    if (!verified.valid) {
      await this.repository.recordRejected(provider.name, verified.reason);
      this.logger.warn(`Rejected a ${provider.name} webhook: ${verified.reason}`);
      throw new WebhookSignatureInvalidError();
    }

    const target = await this.repository.findTransactionForWebhook({
      provider: provider.name,
      transactionId: verified.transactionId,
      providerTransactionId: verified.providerTransactionId,
    });

    const event = await this.repository.claimEvent({
      provider: provider.name,
      eventKey: verified.eventKey,
      payload: verified.payload,
      transactionId: target?.id ?? null,
      companyId: target?.companyId ?? null,
      providerTransactionId:
        verified.providerTransactionId ?? target?.providerTransactionId ?? null,
    });

    if (event.duplicate) return { received: true, duplicate: true };

    if (!target) {
      // Genuine, but about nothing we know. 200, so the provider stops retrying.
      await this.repository.finishEvent(event.id, 'IGNORED', 'No matching transaction.');
      return { received: true, duplicate: false };
    }

    try {
      const result = await this.context.runAsSystem(`${provider.name}-webhook`, null, () =>
        this.transactions.syncWithProvider(target.companyId, target.id, {
          force: true,
          fromWebhook: true,
        }),
      );
      await this.repository.finishEvent(
        event.id,
        result.changed ? 'PROCESSED' : 'IGNORED',
        result.changed ? null : 'No state change.',
      );
      return { received: true, duplicate: false, status: result.status };
    } catch (error) {
      await this.repository.finishEvent(event.id, 'FAILED', (error as Error).message);
      this.logger.error(`Webhook processing failed for transaction ${target.id}.`);
      throw error;
    }
  }
}
