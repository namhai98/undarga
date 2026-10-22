import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type PaymentTransactionKind,
  type PaymentTransactionStatus,
  type PaymentWebhookStatus,
} from '@prisma/client';
import { PlatformPrismaService } from '../database/platform-prisma.service';

/**
 * The payments code that must run before a company is known.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS ON THE PLATFORM CONNECTION (allowlisted in nest.js)
 * ---------------------------------------------------------------------------
 *
 * A webhook arrives as an anonymous HTTP call naming a provider payment. Which
 * company owns it is exactly the question being asked, so it cannot be asked
 * through a connection that must already know. This file answers it with one
 * lookup by an id the delivery had to SIGN, and then the caller re-enters that
 * company through `runInCompany()` before writing anything about the payment.
 *
 * It also owns `payment_webhook_event`, a platform table the tenant role is
 * denied outright, and the operator console's cross-tenant read of
 * transactions (`platform:billing:manage`). Every select is an explicit list;
 * no customer personal data is read here.
 */
@Injectable()
export class PaymentPlatformRepository {
  constructor(private readonly prisma: PlatformPrismaService) {}

  /** Which company owns a payment named by a verified webhook. */
  async findTransactionForWebhook(where: {
    provider: string;
    transactionId?: string | null;
    providerTransactionId?: string | null;
  }) {
    if (!where.transactionId && !where.providerTransactionId) return null;
    return this.prisma.paymentTransaction.findFirst({
      where: {
        provider: where.provider,
        ...(where.transactionId && isUuid(where.transactionId)
          ? { id: where.transactionId }
          : { providerTransactionId: where.providerTransactionId ?? '__none__' }),
      },
      select: { id: true, companyId: true, provider: true, providerTransactionId: true },
    });
  }

  async findTransactionCompany(transactionId: string) {
    return this.prisma.paymentTransaction.findFirst({
      where: { id: transactionId },
      select: { id: true, companyId: true, kind: true },
    });
  }

  /**
   * Record a delivery, deduplicated on (provider, eventKey).
   *
   * A redelivery of an event already PROCESSED is a duplicate and does nothing.
   * One that was IGNORED or FAILED is tried again — "the provider had not
   * caught up yet" is exactly when a provider retries.
   */
  async claimEvent(data: {
    provider: string;
    eventKey: string;
    payload: unknown;
    transactionId: string | null;
    companyId: string | null;
    providerTransactionId: string | null;
  }): Promise<{ id: string; duplicate: boolean }> {
    try {
      const created = await this.prisma.paymentWebhookEvent.create({
        data: {
          provider: data.provider,
          eventKey: data.eventKey.slice(0, 200),
          signatureValid: true,
          payload: sanitize(data.payload),
          transactionId: data.transactionId,
          companyId: data.companyId,
          providerTransactionId: data.providerTransactionId?.slice(0, 128) ?? null,
        },
        select: { id: true },
      });
      return { id: created.id, duplicate: false };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const existing = await this.prisma.paymentWebhookEvent.findUniqueOrThrow({
        where: {
          provider_eventKey: { provider: data.provider, eventKey: data.eventKey.slice(0, 200) },
        },
        select: { id: true, status: true },
      });
      await this.prisma.paymentWebhookEvent.update({
        where: { id: existing.id },
        data: {
          attempts: { increment: 1 },
          ...(existing.status === 'PROCESSED' ? {} : { status: 'RECEIVED' }),
        },
      });
      return { id: existing.id, duplicate: existing.status === 'PROCESSED' };
    }
  }

  async finishEvent(id: string, status: PaymentWebhookStatus, error?: string | null) {
    await this.prisma.paymentWebhookEvent.update({
      where: { id },
      data: { status, error: error?.slice(0, 1000) ?? null, processedAt: new Date() },
    });
  }

  /** A delivery that failed verification: kept for debugging, nothing from it trusted. */
  async recordRejected(provider: string, reason: string) {
    await this.prisma.paymentWebhookEvent.create({
      data: {
        provider,
        // Unique per delivery: rejected calls must never dedupe a genuine one.
        eventKey: `rejected:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
        signatureValid: false,
        status: 'REJECTED',
        error: reason.slice(0, 1000),
        processedAt: new Date(),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Operator console
  // ---------------------------------------------------------------------------

  async listTransactions(query: {
    companyId?: string;
    kind?: PaymentTransactionKind;
    status?: PaymentTransactionStatus;
    limit: number;
    offset: number;
  }) {
    const where: Prisma.PaymentTransactionWhereInput = {
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.paymentTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          companyId: true,
          kind: true,
          status: true,
          amountMinor: true,
          refundedMinor: true,
          feeMinor: true,
          currencyCode: true,
          provider: true,
          providerTransactionId: true,
          providerPaymentId: true,
          failureReason: true,
          appointmentId: true,
          subscriptionInvoiceId: true,
          createdAt: true,
          succeededAt: true,
          company: { select: { slug: true, displayName: true } },
          subscriptionInvoice: { select: { number: true } },
        },
      }),
      this.prisma.paymentTransaction.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        companySlug: row.company.slug,
        companyName: row.company.displayName,
        kind: row.kind,
        status: row.status,
        amountMinor: row.amountMinor.toString(),
        refundedMinor: row.refundedMinor.toString(),
        feeMinor: row.feeMinor.toString(),
        currencyCode: row.currencyCode,
        provider: row.provider,
        providerReference: row.providerPaymentId ?? row.providerTransactionId,
        failureReason: row.failureReason,
        // Which appointment, by id only — its customer is tenant data.
        appointmentId: row.appointmentId,
        invoiceNumber: row.subscriptionInvoice?.number ?? null,
        createdAt: row.createdAt,
        succeededAt: row.succeededAt,
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async listWebhookEvents(query: { status?: PaymentWebhookStatus; limit: number; offset: number }) {
    const where: Prisma.PaymentWebhookEventWhereInput = query.status
      ? { status: query.status }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.paymentWebhookEvent.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          provider: true,
          eventKey: true,
          status: true,
          signatureValid: true,
          transactionId: true,
          companyId: true,
          error: true,
          attempts: true,
          receivedAt: true,
          processedAt: true,
        },
      }),
      this.prisma.paymentWebhookEvent.count({ where }),
    ]);
    return { items: rows, total, limit: query.limit, offset: query.offset };
  }
}

const SENSITIVE_KEY = /card|pan|cvv|cvc|secret|token|password|pin|signature|sig$/i;

/**
 * What of a webhook body is kept for debugging: sensitive-looking keys dropped
 * at every depth, and the whole thing capped. Providers used here never send
 * card data; this is the belt to that braces.
 */
function sanitize(payload: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  const clean = (value: unknown, depth: number): unknown => {
    if (depth > 6) return '[depth]';
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => clean(v, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !SENSITIVE_KEY.test(key))
          .map(([key, v]) => [key, clean(v, depth + 1)]),
      );
    }
    if (typeof value === 'string') return value.slice(0, 500);
    return value;
  };
  if (payload === undefined || payload === null) return Prisma.JsonNull;
  const cleaned = clean(payload, 0);
  return JSON.stringify(cleaned).length > 8_000
    ? { truncated: true }
    : (cleaned as Prisma.InputJsonValue);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
