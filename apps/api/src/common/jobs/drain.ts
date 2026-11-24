import type { Logger } from '@nestjs/common';

/**
 * Wait for a background run that is already in progress before the process
 * goes on shutting down — so a deploy or restart does not cut a batch off
 * half-way while the database connection closes under it.
 *
 * Bounded: a run that outlasts `timeoutMs` is left to its own claims and
 * retries (every worker's work is claimed per row and safe to pick up again),
 * so shutdown never hangs on a slow provider.
 *
 * Nest destroys modules in reverse dependency order, so a worker's
 * onModuleDestroy runs before the database and Redis modules close.
 */
export async function drain(
  work: Promise<unknown> | null,
  name: string,
  logger: Logger,
  timeoutMs = 10_000,
): Promise<void> {
  if (!work) return;
  logger.log(`Waiting for the running ${name} to finish before shutdown`);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  const outcome = await Promise.race([
    work.then(
      () => 'done' as const,
      () => 'done' as const,
    ),
    timedOut,
  ]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    logger.warn(
      `${name} still running after ${timeoutMs} ms; shutting down anyway (its work is retried)`,
    );
  }
}
