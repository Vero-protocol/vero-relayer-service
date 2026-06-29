import { randomUUID } from 'crypto';
import pino, { Logger, LoggerOptions } from 'pino';
import { Writable } from 'stream';

export const REDACT_PATHS = [
  'password',
  'pass',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'privateKey',
  'secretKey',
  'seed',
  'seedPhrase',
  'mnemonic',
  'signature',
  'authorization',
  'Authorization',
  'headers.authorization',
  'headers.Authorization',
  'headers.cookie',
  'headers.Cookie',
  'req.headers.authorization',
  'req.headers.Authorization',
  'req.headers.cookie',
  'req.headers.Cookie',
  'wallet.privateKey',
  'wallet.secretKey',
  'config.privateKey',
  'config.secretKey',
  'env',
  'STELLAR_SECRET_KEY',
  'stellarSecretKey',
  'stellar.secretKey'
] as const;

type Env = Record<string, string | undefined>;

type RequestLike = {
  headers?: Record<string, string | string[] | undefined>;
  method?: string;
  originalUrl?: string;
  url?: string;
  requestId?: string;
  log?: Logger;
};

type ResponseLike = {
  statusCode?: number;
  setHeader?: (name: string, value: string) => void;
  on?: (event: 'finish', listener: () => void) => void;
};

type NextFunction = () => void;

function parseBoolean(value: string | undefined): boolean {
  return String(value || '').toLowerCase() === 'true';
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getErrorAlertConfig(env: Env) {
  const webhookUrl = env.ERROR_ALERT_WEBHOOK_URL || env.ALERT_WEBHOOK_URL || env.SLACK_WEBHOOK_URL || env.ALERT_SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    return null;
  }

  return {
    webhookUrl,
    threshold: parsePositiveNumber(env.ERROR_ALERT_THRESHOLD, 5),
    windowMs: parsePositiveNumber(env.ERROR_ALERT_WINDOW_MS, 60_000)
  };
}

function createErrorAlertHook(options: { env?: Env } = {}) {
  const env = options.env || process.env;
  const config = getErrorAlertConfig(env);

  if (!config) {
    return undefined;
  }

  let errorCount = 0;
  let windowStart = 0;
  let lastAlertAt = 0;

  return function logMethod(args: unknown[], method: (this: Logger, ...args: unknown[]) => void, level: number) {
    if (typeof method !== 'function') {
      return;
    }

    if (level < 50) {
      return method.apply(this, args);
    }

    const now = Date.now();

    if (!windowStart || now - windowStart >= config.windowMs) {
      windowStart = now;
      errorCount = 0;
    }

    errorCount += 1;

    if (errorCount < config.threshold || (lastAlertAt && now - lastAlertAt < config.windowMs)) {
      return method.apply(this, args);
    }

    lastAlertAt = now;

    const stringArg = args.find(arg => typeof arg === 'string');
    const objectArg = args.find(arg => arg && typeof arg === 'object' && 'message' in arg && typeof (arg as { message?: unknown }).message === 'string');
    const message = stringArg
      || (objectArg && typeof objectArg === 'object' && 'message' in objectArg && typeof (objectArg as { message?: unknown }).message === 'string'
        ? (objectArg as { message: string }).message
        : undefined)
      || 'Error spike detected';

    const payload = {
      alertType: 'error-spike',
      threshold: config.threshold,
      count: errorCount,
      windowMs: config.windowMs,
      message,
      timestamp: new Date(now).toISOString()
    };

    setImmediate(async () => {
      try {
        await fetch(config.webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
      } catch {
        // Intentionally swallow alert delivery errors so logging remains non-blocking.
      }
    });

    return method.apply(this, args);
  };
}

export function createLogger(options: { env?: Env; stream?: Writable } = {}): Logger {
  const env = options.env || process.env;
  const errorAlertHook = createErrorAlertHook({ env });
  const loggerOptions: LoggerOptions = {
    level: env.LOG_LEVEL || 'info',
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[Redacted]',
      remove: parseBoolean(env.LOG_REDACT_REMOVE)
    },
    formatters: {
      level(label: string) {
        return { level: label };
      }
    },
    ...(errorAlertHook ? { hooks: { logMethod: errorAlertHook } } : {})
  };

  return pino(loggerOptions, options.stream);
}

export const logger = createLogger();

function normalizeHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value.find(item => typeof item === 'string' && item.trim()) || null;
  }

  return typeof value === 'string' && value.trim() ? value : null;
}

export function getRequestId(req: RequestLike): string {
  const headers = req.headers || {};
  return normalizeHeaderValue(headers['x-request-id']) || normalizeHeaderValue(headers['x-correlation-id']) || randomUUID();
}

function getRequestPath(req: RequestLike): string {
  const rawUrl = req.originalUrl || req.url || '';

  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return rawUrl.split('?')[0];
  }
}

export function requestLoggerMiddleware(options: { logger?: Logger; enabled?: boolean } = {}) {
  const baseLogger = options.logger || logger;
  const enabled = options.enabled !== undefined
    ? options.enabled
    : process.env.ENABLE_HTTP_REQUEST_LOGS !== 'false';

  return function requestLogger(req: RequestLike, res: ResponseLike, next: NextFunction): void {
    const requestId = getRequestId(req);
    const requestLog = baseLogger.child({ requestId });
    const startedAt = process.hrtime.bigint();

    req.requestId = requestId;
    req.log = requestLog;

    if (typeof res.setHeader === 'function') {
      res.setHeader('x-request-id', requestId);
    }

    if (enabled && typeof res.on === 'function') {
      res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        requestLog.info({
          method: req.method,
          path: getRequestPath(req),
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs)
        }, 'request completed');
      });
    }

    next();
  };
}
