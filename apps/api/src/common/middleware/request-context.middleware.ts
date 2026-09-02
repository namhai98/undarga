import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { RequestContextService } from '../../tenancy/context/request-context.service';
import {
  REQUEST_CONTEXT_KEY,
  type RequestWithContext,
} from '../../tenancy/guards/request-with-context';

/**
 * Opens the AsyncLocalStorage context for the request.
 *
 * This must be middleware rather than a guard or an interceptor, because only
 * middleware can wrap the entire remainder of the request in a callback — which
 * is what `als.run()` needs. Guards run *inside* this callback and mutate the
 * store via `attachActor` / `attachTenant`.
 *
 * Registered for every route including public ones, so that a 401 still has a
 * request id in its response body and its log line.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly context: RequestContextService) {}

  use(req: RequestWithContext, res: Response, next: NextFunction): void {
    // Honour an inbound correlation id so a trace spans the gateway and the
    // API, but never let it be used for anything but logging.
    const inbound = req.headers['x-request-id'];
    const requestId =
      typeof inbound === 'string' && /^[\w-]{8,64}$/.test(inbound) ? inbound : randomUUID();

    const ctx = {
      requestId,
      // Replaced by JwtAuthGuard once the caller is identified.
      actor: { kind: 'SYSTEM', name: 'anonymous' } as const,
      tenant: null,
      startedAt: new Date(),
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    };

    req.requestId = requestId;
    req[REQUEST_CONTEXT_KEY] = ctx;
    res.setHeader('x-request-id', requestId);

    this.context.run(ctx, () => next());
  }
}
