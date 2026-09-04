import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Response } from 'express';
import { RequestContextService } from '../../tenancy/context/request-context.service';
import type { RequestWithContext } from '../../tenancy/guards/request-with-context';

/**
 * One structured line per request.
 *
 * Carries `requestId` and, once TenantGuard has run, `companyId` — so a support
 * question ("what happened to this booking?") can be answered by filtering the
 * log on either. That is the whole reason the request context exists as
 * ambient state rather than a parameter.
 *
 * Deliberately logs no bodies, no query strings and no headers: they carry
 * customer names, phone numbers and bearer tokens, and a log is a much easier
 * thing to exfiltrate than a database.
 */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly context: RequestContextService) {}

  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (execution.getType() !== 'http') return next.handle();

    const http = execution.switchToHttp();
    const request = http.getRequest<RequestWithContext>();
    const response = http.getResponse<Response>();
    const startedAt = process.hrtime.bigint();

    const finish = (outcome: 'ok' | 'error') => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const tenant = this.context.tenantOrNull();
      const actor = this.context.actor;

      const parts = [
        `${request.method} ${request.path}`,
        `${response.statusCode}`,
        `${ms.toFixed(1)}ms`,
        `req=${request.requestId ?? '-'}`,
        `actor=${actor?.kind ?? 'ANONYMOUS'}`,
        `company=${tenant?.company.slug ?? '-'}`,
      ];

      if (outcome === 'error' || response.statusCode >= 500) {
        this.logger.warn(parts.join(' '));
      } else {
        this.logger.log(parts.join(' '));
      }
    };

    return next.handle().pipe(
      tap({
        next: () => finish('ok'),
        // The exception filter has not run yet, so statusCode is not final;
        // the filter logs the error itself. This line records the timing.
        error: () => finish('error'),
      }),
    );
  }
}
