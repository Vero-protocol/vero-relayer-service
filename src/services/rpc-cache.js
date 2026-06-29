'use strict';

/**
 * Redis-backed RPC cache decorator.
 *
 * Wraps async RPC calls with a persistent cache layer so repeated requests
 * for the same data (fee stats, account info, etc.) are served from Redis
 * instead of hitting the upstream RPC provider.
 *
 * Cache keys are scoped by network to prevent data collision across
 * testnet/mainnet (issue #68 security requirement).
 *
 * Usage:
 *   const rpcCache = createRpcCache();
 *   const cachedFeeStats = rpcCache.wrap(getFeeStats, {
 *     ttlMs: 30_000,
 *     keyPrefix: 'fee-stats'
 *   });
 */

const Redis = require('ioredis');
const crypto = require('crypto');
const { getRedisConnectionOptions } = require('../queue/redis');
const { logger } = require('../logger');

/** Default TTL per method type (milliseconds) */
const DEFAULT_TTL = {
  account: 10_000,   // 10 seconds — accounts change between transactions
  'fee-stats': 60_000 // 60 seconds — fee market moves slowly
};

/** Prefix applied to every cache key in Redis */
const CACHE_KEY_PREFIX = 'rpc-cache';

/**
 * Create a stable, content-addressed hash for a set of arguments.
 * @param {...unknown} args
 * @returns {string}
 */
function hashArgs(...args) {
  const json = args
    .map(arg => {
      try {
        return JSON.stringify(arg, (key, value) => {
          // Normalise BigInt to string so serialisation is stable across runs
          if (typeof value === 'bigint') {
            return value.toString();
          }
          // Sort object keys so {x:1, y:2} and {y:2, x:1} produce same hash
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            return Object.keys(value).sort().reduce((sorted, k) => {
              sorted[k] = value[k];
              return sorted;
            }, {});
          }
          return value;
        });
      } catch {
        return String(arg);
      }
    })
    .join('\0');
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
}

/**
 * Build a Redis cache key that is unique per network, method, and arguments.
 *
 * Format: `rpc-cache:{network}:{keyPrefix}:{argHash}`
 *
 * @param {string} network  - e.g. 'testnet' or 'mainnet'
 * @param {string} keyPrefix - logical method group, e.g. 'fee-stats'
 * @param {string} argHash  - content hash of the function arguments
 * @returns {string}
 */
function buildCacheKey(network, keyPrefix, argHash) {
  return `${CACHE_KEY_PREFIX}:${network}:${keyPrefix}:${argHash}`;
}

/**
 * @typedef {Object} RpcCacheOptions
 * @property {number} [ttlMs]         - Cache TTL in milliseconds (default varies by prefix)
 * @property {string} keyPrefix       - Logical group name for the method (required)
 * @property {function(...args): string} [keyFn] - Custom cache key derivation from args
 * @property {function(...args): string} [networkFn] - Custom network resolver
 */

/**
 * @typedef {Object} RpcCacheStats
 * @property {number} hits
 * @property {number} misses
 * @property {number} errors
 */

/**
 * @typedef {Object} RpcCacheInstance
 * @property {function(Function, RpcCacheOptions): Function} wrap - Decorate an async function with caching
 * @property {function(): Promise<void>} clearCache - Flush all cached entries
 * @property {function(): Promise<void>} close - Disconnect Redis
 * @property {function(): RpcCacheStats} stats - Current hit/miss counters
 */

/**
 * Create a no-op cache that bypasses Redis entirely.
 * Used when Redis is not configured or unavailable.
 * @returns {RpcCacheInstance}
 */
function createNoopCache() {
  const stats = { hits: 0, misses: 0, errors: 0 };
  return {
    wrap: (fn, opts) => {
      if (!opts || !opts.keyPrefix) {
        throw new Error('rpc-cache: keyPrefix is required when wrapping a function');
      }
      // Return the original function unwrapped — no caching
      return fn;
    },
    clearCache: async () => 0,
    close: async () => {},
    getStats: () => ({ ...stats }),
    stats
  };
}

/**
 * Create a Redis-backed RPC cache instance.
 *
 * If Redis is not configured (missing env vars) the cache degrades to a no-op
 * so the application never crashes because the cache layer is unavailable.
 *
 * @param {object} [options]
 * @param {object} [options.redis]        - Pre-configured Redis client (optional)
 * @param {object} [options.connection]   - Redis connection options (ignored if `redis` provided)
 * @param {number} [options.defaultTtlMs] - Fallback TTL when none is configured for a prefix
 * @returns {RpcCacheInstance}
 */
function createRpcCache(options = {}) {
  let redis;

  try {
    redis = options.redis || new Redis(options.connection || getRedisConnectionOptions());
  } catch (err) {
    logger.warn({ error: err.message }, '[rpc-cache] Redis not configured, running without cache');
    return createNoopCache();
  }

  // Suppress connection errors in tests and graceful shutdowns — the app
  // should never crash because the cache layer is unavailable.
  redis.on('error', err => {
    logger.warn({ error: err.message }, '[rpc-cache] Redis connection error');
  });

  /** @type {RpcCacheStats} */
  const stats = { hits: 0, misses: 0, errors: 0 };

  // Regex that matches Stellar secret seeds and account IDs so we never cache
  // sensitive data by accident.
  const SENSITIVE_VALUE_RE = /\b[SG][A-Z2-7]{55}\b/;

  /**
   * Wrap an async function with a Redis read-through cache.
   *
   * On cache hit the cached value is deserialised and returned without
   * invoking `fn`. On cache miss `fn` is called, its result is serialised
   * and stored in Redis, and the result is returned.
   *
   * If Redis is unavailable the function degrades to a direct call so the
   * application remains operational.
   *
   * @param {Function} fn       - The async RPC function to wrap
   * @param {RpcCacheOptions} opts
   * @returns {Function} Wrapped function with the same signature as `fn`
   */
  function wrap(fn, opts) {
    if (!opts || !opts.keyPrefix) {
      throw new Error('rpc-cache: keyPrefix is required when wrapping a function');
    }

    const ttlMs = opts.ttlMs || DEFAULT_TTL[opts.keyPrefix] || options.defaultTtlMs || 60_000;
    const keyPrefix = opts.keyPrefix;
    const keyFn = opts.keyFn || ((...args) => hashArgs(...args));

    /**
     * Resolve the network string used in cache keys.
     * Defaults to `process.env.STELLAR_NETWORK || 'testnet'`.
     */
    const networkFn = opts.networkFn || (() => process.env.STELLAR_NETWORK || 'testnet');

    async function wrapped(...args) {
      const network = typeof networkFn === 'function' ? networkFn(...args) : networkFn;
      const argKey = typeof keyFn === 'function' ? keyFn(...args) : keyFn;
      const cacheKey = buildCacheKey(network, keyPrefix, argKey);

      try {
        const cached = await redis.get(cacheKey);
        if (cached !== null) {
          stats.hits += 1;
          logger.debug({ cacheKey, network, keyPrefix }, '[rpc-cache] cache HIT');
          return JSON.parse(cached);
        }
      } catch (err) {
        stats.errors += 1;
        logger.warn({ error: err.message, cacheKey }, '[rpc-cache] read error, falling through to live RPC');
      }

      stats.misses += 1;
      logger.debug({ cacheKey, network, keyPrefix }, '[rpc-cache] cache MISS');

      const result = await fn(...args);

      // Do not cache responses that contain sensitive Stellar keys/seeds.
      const serialised = JSON.stringify(result);
      if (SENSITIVE_VALUE_RE.test(serialised)) {
        logger.warn({ cacheKey, keyPrefix }, '[rpc-cache] refusing to cache response with sensitive data');
        return result;
      }

      try {
        await redis.set(cacheKey, serialised, 'PX', ttlMs);
        logger.debug({ cacheKey, ttlMs, network, keyPrefix }, '[rpc-cache] cached');
      } catch (err) {
        stats.errors += 1;
        logger.warn({ error: err.message, cacheKey }, '[rpc-cache] write error, result served uncached');
      }

      return result;
    }

    return wrapped;
  }

  /**
   * Flush every key with the `rpc-cache:` prefix.
   * @returns {Promise<number>} Number of deleted keys
   */
  async function clearCache() {
    let deletedCount = 0;
    let cursor = '0';

    do {
      const result = await redis.scan(cursor, 'MATCH', `${CACHE_KEY_PREFIX}:*`, 'COUNT', 100);
      cursor = result[0];
      const keys = result[1];
      if (keys.length > 0) {
        await redis.del(...keys);
        deletedCount += keys.length;
      }
    } while (cursor !== '0');

    logger.info({ deletedCount }, '[rpc-cache] cache cleared');
    return deletedCount;
  }

  /**
   * Disconnect the underlying Redis client.
   */
  async function close() {
    await redis.quit();
  }

  /**
   * Return a snapshot of the hit/miss counters.
   * @returns {RpcCacheStats}
   */
  function getStats() {
    return { ...stats };
  }

  return { wrap, clearCache, close, getStats, stats };
}

module.exports = {
  CACHE_KEY_PREFIX,
  DEFAULT_TTL,
  createRpcCache,
  buildCacheKey,
  hashArgs
};
