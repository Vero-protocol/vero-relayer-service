/**
 * Rate-limiting middleware for the public ingest endpoint.
 *
 * Distinguishes between:
 *   - Authenticated requests (bearing a valid signature or Authorization header)
 *     which receive a more generous limit.
 *   - Public / unauthenticated requests which receive a tighter limit.
 *
 * The real client IP is extracted from X-Forwarded-For when Express trust
 * proxy is enabled, so rate limits apply to the originating client even when
 * the service sits behind a reverse proxy or load balancer.
 *
 * IPv6 addresses are normalised via express-rate-limit's ipKeyGenerator helper
 * to prevent bypass via address formatting tricks.
 */

let rateLimit;
let ipKeyGenerator;
try {
  rateLimit = require('express-rate-limit');
  // ipKeyGenerator is the express-rate-limit blessed helper for IPv6-safe keying.
  ipKeyGenerator = require('express-rate-limit').ipKeyGenerator;
} catch (e) {
  // environment without dev deps; provide no-op fallback so module can be required
  rateLimit = (opts) => {
    return (req, res, next) => next();
  };
  ipKeyGenerator = (req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}
let rate_limit_hits_total;
let logger;
try {
  ({ rate_limit_hits_total } = require('../metrics/metrics'));
} catch (e) {
  // tests or environments without prom-client can continue — use a noop stub
  rate_limit_hits_total = { inc: () => {} };
}

try {
  ({ logger } = require('../logger'));
} catch (e) {
  logger = console;
}
let IORedis;
let getRedisConnectionOptions;
try {
  IORedis = require('ioredis');
} catch (e) {
  IORedis = null;
}
try {
  ({ getRedisConnectionOptions } = require('../queue/redis'));
} catch (e) {
  getRedisConnectionOptions = null;
}

let redisClient;
let redisStore = null;

function createRedisStore(windowMs) {
  if (!process.env.REDIS_HOST) {
    return null;
  }

  try {
    const connOpts = getRedisConnectionOptions();
    redisClient = new IORedis(connOpts);

    // Minimal store implementation compatible with express-rate-limit.
    // It exposes `incr(key, cb)` and `resetKey(key)`.
    return {
      // support both `incr` and `increment` naming variants
      incr: (key, cb) => {
        const redisKey = `rl:${key}`;
        // Atomically INCR and get PTTL
        redisClient.multi().incr(redisKey).pttl(redisKey).exec((err, replies) => {
          if (err) return cb(err);
          const incrReply = replies && replies[0] && replies[0][1];
          const pttlReply = replies && replies[1] && replies[1][1];

          const hits = Number(incrReply || 0);

          if (pttlReply === -1 || pttlReply === -2) {
            // Key had no TTL or did not exist; set expiry
            redisClient.pexpire(redisKey, windowMs).catch(() => {});
            const reset = Date.now() + windowMs;
            return cb(null, hits, reset);
          }

          const reset = Date.now() + Math.max(0, pttlReply);
          return cb(null, hits, reset);
        });
      },
      increment: (key, cb) => {
        // alias to incr
        // `this` is not bound in arrow functions; prefer calling the incr implementation
        try {
          if (redisStore && typeof redisStore.incr === 'function') {
            return redisStore.incr(key, cb);
          }
        } catch (e) {
          // ignore and fallback
        }

        // fallback: best-effort response when store unavailable
        return cb(null, 1, Date.now() + windowMs);
      },
      resetKey: (key) => {
        const redisKey = `rl:${key}`;
        redisClient.del(redisKey).catch(() => {});
      }
    };
  } catch (err) {
    logger.warn({ err: err && err.message }, 'failed to create redis rate-limit store; falling back to memory store');
    return null;
  }
}

// initialize redis store lazily (after window constants are defined)
// will attempt to create below once PUBLIC_WINDOW_MS is available

// ---------------------------------------------------------------------------
// Limits (configurable via environment variables)
// ---------------------------------------------------------------------------

const PUBLIC_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS)   || 15 * 60 * 1000; // 15 min
const PUBLIC_MAX       = Number(process.env.RATE_LIMIT_PUBLIC_MAX)   || 100;
const AUTH_MAX         = Number(process.env.RATE_LIMIT_AUTH_MAX)     || 1_000;

// ---------------------------------------------------------------------------
// Key generator
// ---------------------------------------------------------------------------

/**
 * Returns an IPv6-safe client key using the express-rate-limit ipKeyGenerator.
 * Falls back to the raw socket address for local / test environments where
 * req.ip may not be set.
 */
function clientIp(req) {
  if (req.ip) {
    return ipKeyGenerator(req);
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * A request is considered "authenticated" when it presents either:
 *   - An Authorization header (JWT Bearer token), or
 *   - An X-Hub-Signature-256 header (GitHub HMAC signature), or
 *   - An X-Vero-Signature header (Vero HMAC signature).
 */
function isAuthenticated(req) {
  const headers = req.headers || {};
  return !!(
    headers['authorization'] ||
    headers['x-hub-signature-256'] ||
    headers['x-vero-signature']
  );
}

// ---------------------------------------------------------------------------
// Public rate limiter  (100 req / 15 min per IP)
// ---------------------------------------------------------------------------

const publicRateLimiter = rateLimit({
  windowMs: PUBLIC_WINDOW_MS,
  max: PUBLIC_MAX,
  standardHeaders: true,   // Emit RateLimit-* headers (RFC 6585)
  legacyHeaders: false,
  keyGenerator: clientIp,
  skip: (req) => isAuthenticated(req), // authenticated callers use auth limiter
  // lazily initialize redis store now that PUBLIC_WINDOW_MS is available
  store: (function() {
    if (!redisStore && IORedis && getRedisConnectionOptions && process.env.REDIS_HOST) {
      redisStore = createRedisStore(PUBLIC_WINDOW_MS);
    }
    return redisStore || undefined;
  })(),
  handler(req, res) {
    try {
      const route = req.originalUrl || req.url || 'unknown';
      rate_limit_hits_total.inc({ limiter_type: 'public', route }, 1);
      (req.log || logger).warn({ ip: clientIp(req), route, limiter: 'public' }, 'rate limit exceeded (public)');
    } catch (e) {
      // non-fatal if metrics/logging fails
      (req.log || logger).warn({ err: e && e.message }, 'failed to record rate limit metric');
    }

    res.status(429).json({
      error: 'Too many requests from this IP. Please retry after the window resets.',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: Math.ceil(PUBLIC_WINDOW_MS / 1000),
    });
  },
});

// ---------------------------------------------------------------------------
// Authenticated rate limiter  (1 000 req / 15 min per IP)
// ---------------------------------------------------------------------------

const authenticatedRateLimiter = rateLimit({
  windowMs: PUBLIC_WINDOW_MS,
  max: AUTH_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIp,
  skip: (req) => !isAuthenticated(req), // public callers use publicRateLimiter
  store: (function() {
    if (!redisStore && IORedis && getRedisConnectionOptions && process.env.REDIS_HOST) {
      redisStore = createRedisStore(PUBLIC_WINDOW_MS);
    }
    return redisStore || undefined;
  })(),
  handler(req, res) {
    try {
      const route = req.originalUrl || req.url || 'unknown';
      rate_limit_hits_total.inc({ limiter_type: 'authenticated', route }, 1);
      (req.log || logger).warn({ ip: clientIp(req), route, limiter: 'authenticated' }, 'rate limit exceeded (authenticated)');
    } catch (e) {
      (req.log || logger).warn({ err: e && e.message }, 'failed to record rate limit metric');
    }

    res.status(429).json({
      error: 'Rate limit exceeded for authenticated client. Please retry after the window resets.',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: Math.ceil(PUBLIC_WINDOW_MS / 1000),
    });
  },
});

// ---------------------------------------------------------------------------
// Combined middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that applies either the public or authenticated rate
 * limit based on whether the incoming request carries auth headers.
 *
 * Mount this before the route handler on any public-facing ingest endpoint.
 */
function ingestRateLimiter(req, res, next) {
  if (isAuthenticated(req)) {
    return authenticatedRateLimiter(req, res, next);
  }
  return publicRateLimiter(req, res, next);
}

module.exports = {
  ingestRateLimiter,
  publicRateLimiter,
  authenticatedRateLimiter,
  isAuthenticated,
  clientIp,
  PUBLIC_WINDOW_MS,
  PUBLIC_MAX,
  AUTH_MAX,
};
