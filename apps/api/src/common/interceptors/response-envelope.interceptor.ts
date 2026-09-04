import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { RequestWithContext } from '../../tenancy/guards/request-with-context';

export const META_NO_ENVELOPE = 'undarga:noEnvelope';

/**
 * Opt a route out of the envelope.
 *
 * For responses that are not JSON documents — file downloads, redirects, and
 * anything a third party defines the shape of (payment provider webhooks
 * expecting a bare `{ received: true }`).
 */
export const NoEnvelope = () => SetMetadata(META_NO_ENVELOPE, true);

export interface ResponseEnvelope<T> {
  data: T;
  meta: {
    requestId?: string;
  };
}

/**
 * Wraps every successful response as `{ data, meta }`.
 *
 * ---------------------------------------------------------------------------
 * WHY AN ENVELOPE AT ALL
 * ---------------------------------------------------------------------------
 *
 * A predictable outer shape means a client can write one response handler
 * instead of one per endpoint, and it leaves somewhere to put pagination and
 * correlation data later without changing every payload. `meta.requestId`
 * matches the `error.requestId` the exception filter emits, so a user can
 * quote one id whether the call succeeded or failed.
 *
 * Errors are NOT wrapped here — DomainExceptionFilter owns that shape, and it
 * has to, because an exception can be thrown before an interceptor runs.
 *
 * The cost is real: `res.body.data.x` everywhere instead of `res.body.x`, and
 * it is a breaking change to any client written against the unwrapped form.
 * Introduced now, at foundation time, precisely so it never has to be later.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const skip = this.reflector.getAllAndOverride<boolean>(META_NO_ENVELOPE, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skip) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<RequestWithContext>();

    return next.handle().pipe(
      map((data: unknown) => {
        // A 204 produces undefined; wrapping it would turn an empty body into
        // `{"data":null}` and break the "no content" contract.
        if (data === undefined) return undefined;

        // Already enveloped (a controller composing another's output).
        if (isEnvelope(data)) return data;

        return { data, meta: { requestId: request.requestId } } satisfies ResponseEnvelope<unknown>;
      }),
    );
  }
}

function isEnvelope(value: unknown): value is ResponseEnvelope<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    'meta' in value &&
    Object.keys(value).length === 2
  );
}
