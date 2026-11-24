import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * Prisma's own log output, routed through the application logger.
 *
 * Only `warn` (and `info` at debug level) is taken. Prisma's `error` level is
 * deliberately not: it prints every failed statement — including the unique
 * violations the application expects and handles (a redelivered webhook, an
 * idempotent retry) — as a multi-line plain-text block on stderr. That broke
 * the one-JSON-object-per-line format and filled `level=error` alerts with
 * noise. Errors that matter surface as exceptions and are logged once, with a
 * stack, by DomainExceptionFilter or the job that caught them.
 */
export const PRISMA_LOG_LEVELS: Prisma.LogDefinition[] = [{ emit: 'event', level: 'warn' }];

export function forwardPrismaLogs(
  client: { $on(event: 'warn', cb: (e: Prisma.LogEvent) => void): void },
  context: string,
): void {
  const logger = new Logger(context);
  client.$on('warn', (e) => logger.warn(`Prisma: ${e.message}`));
}
