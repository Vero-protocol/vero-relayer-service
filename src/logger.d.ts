import type pino from 'pino';

export const REDACT_PATHS: string[];
export const logger: pino.Logger;
export function createLogger(options?: Record<string, unknown>): pino.Logger;
export function getRequestId(req: { headers?: Record<string, unknown> }): string;
export function requestLoggerMiddleware(options?: Record<string, unknown>): (
  req: Record<string, unknown>,
  res: Record<string, unknown>,
  next: () => void
) => void;