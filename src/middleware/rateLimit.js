/**
 * Rate-limiting middleware for the public ingest endpoint.
 *
 * Distinguishes between:
 *   - Authenticated requests whose GitHub signature has already been
 *     cryptographically verified, which receive a more generous limit.
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
const { sendError } = require('../utils/http-errors');
const { classifySignature, isSignatureVerified } = require('./auth');
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

let redisClient = null;

function getSharedRedisClient() {
  if (!redisClient) {
    redisClient = new IORedis(getRedisConnectionOptions());
  }
  return redisClient;
}

/**
 * Builds a callback-style ("legacy") express-rate-limit store backed by
 * Redis. express-rate-limit auto-detects and promisifies a store that
 * exposes `incr` but not `increment` — deliberately NOT defining
 * `increment` here lets that detection work; defining both breaks it,
 * since express-rate-limit then treats `increment` as the modern
 * promise-returning API and gets `undefined` back from this callback-based
 * one.
 *
 * Each rate limiter needs its own store *instance* — express-rate-limit
 * rejects sharing one store object across multiple rateLimit() calls — so
 * this returns a fresh object on every call. The underlying Redis
 * connection is still shared and lazily created only once.
 */
function createRedisStore(windowMs) {
  if (!process.env.REDIS_HOST) {
    return null;
  }

  try {
    const client = getSharedRedisClient();

    return {
      incr: (key, cb) => {
        const redisKey = `rl:${key}`;
        // Atomically INCR and get PTTL
        client.multi().incr(redisKey).pttl(redisKey).exec((err, replies) => {
          if (err) return cb(err);
          const incrReply = replies && replies[0] && replies[0][1];
          const pttlReply = replies && replies[1] && replies[1][1];

          const hits = Number(incrReply || 0);

          if (pttlReply === -1 || pttlReply === -2) {
            // Key had no TTL or did not exist; set expiry
            client.pexpire(redisKey, windowMs).catch(() => {});
            // resetTime must be a Date instance — express-rate-limit calls
            // .getTime() on it when building RateLimit-* response headers.
            const reset = new Date(Date.now() + windowMs);
            return cb(null, hits, reset);
          }

          const reset = new Date(Date.now() + Math.max(0, pttlReply));
          return cb(null, hits, reset);
        });
      },
      resetKey: (key) => {
        const redisKey = `rl:${key}`;
        client.del(redisKey).catch(() => {});
      },
      // Required by the Store interface (used to undo an increment when
      // skipFailedRequests/skipSuccessfulRequests apply — neither is
      // enabled here, but the method must still exist or rateLimit()
      // throws "An invalid store was passed" at construction time).
      decrement: (key) => {
        const redisKey = `rl:${key}`;
        client.decr(redisKey).catch(() => {});
      }
    };
  } catch (err) {
    logger.warn({ err: err && err.message }, 'failed to create redis rate-limit store; falling back to memory store');
    return null;
  }
}

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
    // ipKeyGenerator takes the IP string itself, not the request object —
    // passing `req` here made every key resolve to the literal string
    // "[object Object]" (isIPv6() rejects a non-string, so it falls through
    // to `return ip` unchanged), collapsing every client into one shared
    // rate-limit counter regardless of actual IP.
    return ipKeyGenerator(req.ip);
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * A request is considered authenticated only after its GitHub HMAC signature
 * has been cryptographically verified by the webhook authentication middleware.
 * Header presence alone must never grant the higher rate-limit tier.
 */
function isAuthenticated(req) {
  return isSignatureVerified(req);
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
  skip(req) {
    // Tier selection and enforcement share this private, cached decision.
    // Classifying inside the first limiter also makes it impossible to mount
    // the dual limiter without establishing the authentication state first.
    classifySignature(req);
    return isAuthenticated(req); // verified callers use auth limiter
  },
  store: createRedisStore(PUBLIC_WINDOW_MS) || undefined,
  handler(req, res) {
    try {
      const route = req.originalUrl || req.url || 'unknown';
      rate_limit_hits_total.inc({ limiter_type: 'public', route }, 1);
      (req.log || logger).warn({ ip: clientIp(req), route, limiter: 'public' }, 'rate limit exceeded (public)');
    } catch (e) {
      // non-fatal if metrics/logging fails
      (req.log || logger).warn({ err: e && e.message }, 'failed to record rate limit metric');
    }

    return sendError(res, 429, 'RATE_LIMIT_EXCEEDED', 'Too many requests from this IP. Please retry after the window resets.', { retryAfter: Math.ceil(PUBLIC_WINDOW_MS / 1000) });
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
  store: createRedisStore(PUBLIC_WINDOW_MS) || undefined,
  handler(req, res) {
    try {
      const route = req.originalUrl || req.url || 'unknown';
      rate_limit_hits_total.inc({ limiter_type: 'authenticated', route }, 1);
      (req.log || logger).warn({ ip: clientIp(req), route, limiter: 'authenticated' }, 'rate limit exceeded (authenticated)');
    } catch (e) {
      (req.log || logger).warn({ err: e && e.message }, 'failed to record rate limit metric');
    }

    return sendError(res, 429, 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded for authenticated client. Please retry after the window resets.', { retryAfter: Math.ceil(PUBLIC_WINDOW_MS / 1000) });
  },
});

// ---------------------------------------------------------------------------
// Combined middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that applies either the public or authenticated rate
 * limit based on a previously established authentication decision.
 *
 * Mount this before the route handler on any public-facing ingest endpoint.
 */
function ingestRateLimiter(req, res, next) {
  return publicRateLimiter(req, res, (err) => {
    if (err) return next(err);
    return authenticatedRateLimiter(req, res, next);
  });
}

/**
 * Closes the cached Redis client, if one was ever created. Primarily used by
 * tests to release the connection so the process can exit cleanly.
 */
async function closeRedisClient() {
  if (!redisClient) return;
  const client = redisClient;
  redisClient = null;
  await client.quit().catch(() => client.disconnect());
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
  closeRedisClient,
};
