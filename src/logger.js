const { randomUUID } = require('crypto');
const pino = require('pino');

const REDACT_PATHS = [
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
];

function parseBoolean(value) {
  return String(value || '').toLowerCase() === 'true';
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getErrorAlertConfig(env = process.env) {
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

function createErrorAlertHook(options = {}) {
  const env = options.env || process.env;
  const config = getErrorAlertConfig(env);

  if (!config) {
    return undefined;
  }

  let errorCount = 0;
  let windowStart = 0;
  let lastAlertAt = 0;

  return function logMethod(args, method, level) {
    if (typeof method !== 'function') {
      return method;
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
    const objectArg = args.find(arg => arg && typeof arg === 'object' && typeof arg.message === 'string');
    const message = stringArg
      || (objectArg && objectArg.message)
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
      } catch (_) {
        // Intentionally swallow alert delivery errors so logging remains non-blocking.
      }
    });

    return method.apply(this, args);
  };
}

function createLogger(options = {}) {
  const env = options.env || process.env;
  const errorAlertHook = createErrorAlertHook({ env });
  const loggerOptions = {
    level: env.LOG_LEVEL || 'info',
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: '[Redacted]',
      remove: parseBoolean(env.LOG_REDACT_REMOVE)
    },
    formatters: {
      level(label) {
        return { level: label };
      }
    },
    ...(errorAlertHook ? { hooks: { logMethod: errorAlertHook } } : {})
  };

  return pino(loggerOptions, options.stream);
}

const logger = createLogger();

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) {
    return value.find(item => typeof item === 'string' && item.trim()) || null;
  }

  return typeof value === 'string' && value.trim() ? value : null;
}

function getRequestId(req) {
  const headers = req.headers || {};
  return normalizeHeaderValue(headers['x-request-id']) || normalizeHeaderValue(headers['x-correlation-id']) || randomUUID();
}

function getRequestPath(req) {
  const rawUrl = req.originalUrl || req.url || '';

  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch (_) {
    return rawUrl.split('?')[0];
  }
}

function requestLoggerMiddleware(options = {}) {
  const baseLogger = options.logger || logger;
  const enabled = options.enabled !== undefined
    ? options.enabled
    : process.env.ENABLE_HTTP_REQUEST_LOGS !== 'false';

  return function requestLogger(req, res, next) {
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

module.exports = {
  REDACT_PATHS,
  createLogger,
  getRequestId,
  logger,
  requestLoggerMiddleware
};
