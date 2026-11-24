import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import type { AppConfig } from '../config';

/** LOG_LEVEL (the usual names) → the Nest levels it enables. */
const LEVELS: Record<string, LogLevel[]> = {
  fatal: ['fatal'],
  error: ['fatal', 'error'],
  warn: ['fatal', 'error', 'warn'],
  info: ['fatal', 'error', 'warn', 'log'],
  debug: ['fatal', 'error', 'warn', 'log', 'debug'],
  trace: ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'],
};

/**
 * The application logger.
 *
 * `LOG_FORMAT=json` (the production default) writes one JSON object per line —
 * level, timestamp, context, message, pid — which every log platform
 * (CloudWatch, Loki, Datadog, Cloud Logging, ELK) can index without a parser.
 * `text` is the coloured human format for development.
 *
 * What is logged is decided elsewhere and is deliberately narrow: one line per
 * request with method, path, status, timing, request id, actor kind and
 * company slug (RequestLoggingInterceptor) — never bodies, query strings,
 * headers or tokens.
 */
export function createAppLogger(config: AppConfig): ConsoleLogger {
  const { logFormat, logLevel } = config.app;
  return new ConsoleLogger({
    json: logFormat === 'json',
    colors: logFormat !== 'json',
    logLevels: LEVELS[logLevel] ?? LEVELS.info,
  });
}
