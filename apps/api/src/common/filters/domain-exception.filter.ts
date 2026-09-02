import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from '../errors';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

/**
 * Single place where an error becomes a status code.
 *
 * Two rules that matter for tenant safety:
 *   1. A DomainError with exposeMessage=false never shows its message to the
 *      caller — those messages name internal models and query shapes.
 *   2. Unknown errors are always 500 with a generic body. A Prisma error text
 *      leaking through here could disclose table and column names.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request as Request & { requestId?: string }).requestId;

    const { status, body, logLevel, logMessage } = this.translate(exception, requestId);

    if (logLevel === 'error') {
      this.logger.error(logMessage, exception instanceof Error ? exception.stack : undefined);
    } else if (logLevel === 'warn') {
      this.logger.warn(logMessage);
    }

    response.status(status).json(body);
  }

  private translate(
    exception: unknown,
    requestId?: string,
  ): { status: number; body: ErrorBody; logLevel: 'error' | 'warn' | 'none'; logMessage: string } {
    if (exception instanceof DomainError) {
      const exposed = exception.exposeMessage ? exception.message : 'Internal server error.';
      return {
        status: exception.status,
        body: {
          error: {
            code: exception.code,
            message: exposed,
            ...(exception.exposeMessage && exception.details
              ? { details: exception.details }
              : {}),
            requestId,
          },
        },
        // 5xx domain errors are always programmer error; log them loudly.
        logLevel: exception.status >= 500 ? 'error' : 'warn',
        logMessage: `[${exception.code}] ${exception.message}`,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const message =
        typeof res === 'string'
          ? res
          : ((res as { message?: string | string[] }).message ?? exception.message);
      return {
        status,
        body: {
          error: {
            code: status === 404 ? 'RESOURCE_NOT_FOUND' : 'HTTP_ERROR',
            message: Array.isArray(message) ? message.join('; ') : String(message),
            requestId,
          },
        },
        logLevel: status >= 500 ? 'error' : 'none',
        logMessage: `HTTP ${status}: ${exception.message}`,
      };
    }

    return {
      status: 500,
      body: {
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error.', requestId },
      },
      logLevel: 'error',
      logMessage: exception instanceof Error ? exception.message : String(exception),
    };
  }
}
