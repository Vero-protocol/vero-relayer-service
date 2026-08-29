const { logger } = require('../logger');
const { verifyJwtBearer } = require('../middleware/jwt-auth');

let client;
try {
  client = require('prom-client');
} catch (e) {
  // provide a lightweight stub so code can run in environments without prom-client
  client = {
    register: {
      metrics: async () => '',
      contentType: 'text/plain',
      getSingleMetric: () => undefined,
    },
    collectDefaultMetrics: () => {},
    Counter: class {
      constructor() {}
      inc() {}
    },
    Histogram: class {
      constructor() {}
      observe() {}
    }
  };
}

// Collect default metrics (process, memory, etc.).
// Guard against duplicate collection when the module is imported multiple times
try {
  if (!client.register.getSingleMetric || !client.register.getSingleMetric('process_cpu_user_seconds_total')) {
    client.collectDefaultMetrics();
  }
} catch (e) {
  logger.warn({ error: e && e.message }, 'prom-client: failed to collect default metrics');
}

// Counter for total processed events, labeled by task_type for better granularity
const vero_events_processed_total = client.register.getSingleMetric('vero_events_processed_total') || new client.Counter({
  name: 'vero_events_processed_total',
  help: 'Total number of processed Vero events',
  labelNames: ['task_type'],
});

// Histogram for queue latency (seconds)
const queue_latency_seconds = client.register.getSingleMetric('queue_latency_seconds') || new client.Histogram({
  name: 'queue_latency_seconds',
  help: 'Queue latency in seconds',
  labelNames: ['task_type'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

// Counter for rate limit hits, labeled by limiter type and route
const rate_limit_hits_total = client.register.getSingleMetric('rate_limit_hits_total') || new client.Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of HTTP requests rejected due to rate limiting',
  labelNames: ['limiter_type', 'route'],
});

const DEFAULT_METRICS_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_METRICS_RATE_LIMIT_MAX = 60;

/**
 * Build a lightweight in-memory rate limiter for the metrics scrape endpoint.
 *
 * This deliberately avoids importing the shared rateLimit module because that
 * module records rate-limit metrics and imports this module, which would create
 * a circular dependency. The limiter is a defense-in-depth backstop for the
 * authenticated /metrics endpoint; production deployments with multiple
 * instances should still prefer network-level allowlisting where available.
 *
 * @param {{ windowMs?: number, max?: number }} [options]
 * @returns {import('express').RequestHandler}
 */
function createMetricsRateLimiter(options = {}) {
  const windowMs = Number(options.windowMs || process.env.METRICS_RATE_LIMIT_WINDOW_MS) || DEFAULT_METRICS_RATE_LIMIT_WINDOW_MS;
  const max = Number(options.max || process.env.METRICS_RATE_LIMIT_MAX) || DEFAULT_METRICS_RATE_LIMIT_MAX;
  const hitsByClient = new Map();

  return function metricsRateLimiter(req, res, next) {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const current = hitsByClient.get(key);

    let bucket;
    if (!current || current.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      hitsByClient.set(key, bucket);
    } else {
      bucket = current;
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      try {
        rate_limit_hits_total.inc({ limiter_type: 'metrics', route: req.originalUrl || req.url || '/metrics' }, 1);
        (req.log || logger).warn({ ip: key, route: req.originalUrl || req.url || '/metrics' }, 'rate limit exceeded (metrics)');
      } catch (e) {
        // Metrics and logging must never prevent the response.
      }

      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: 'Too many metrics requests. Please retry after the window resets.',
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: retryAfterSeconds,
      });
    }

    return next();
  };
}

const defaultMetricsRateLimiter = createMetricsRateLimiter();

/**
 * Register the authenticated /metrics endpoint on the given Express app.
 *
 * By default this route requires the same JWT Bearer authentication used by
 * internal service endpoints and applies a lightweight per-client rate limit.
 * Tests can inject replacement middleware through options, but production
 * callers should keep the defaults unless /metrics is separately bound to a
 * private interface or protected by infrastructure controls.
 *
 * @param {import('express').Express} app
 * @param {{ authMiddleware?: import('express').RequestHandler, rateLimitMiddleware?: import('express').RequestHandler }} [options]
 */
function registerMetrics(app, options = {}) {
  const authMiddleware = options.authMiddleware || verifyJwtBearer;
  const rateLimitMiddleware = options.rateLimitMiddleware || defaultMetricsRateLimiter;
  const middleware = [rateLimitMiddleware, authMiddleware].filter(Boolean);

  app.get('/metrics', ...middleware, async (req, res) => {
    try {
      const metrics = await client.register.metrics();
      res.set('Content-Type', client.register.contentType);
      res.end(metrics);
    } catch (err) {
      res.status(500).end(err.toString());
    }
  });
}

module.exports = {
  registerMetrics,
  createMetricsRateLimiter,
  vero_events_processed_total,
  queue_latency_seconds,
  rate_limit_hits_total,
};
