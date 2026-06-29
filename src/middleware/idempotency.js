'use strict';

const { getRedisConnectionOptions } = require('../queue/redis');
const { logger } = require('../logger');

// ---------------------------------------------------------------------------
// Idempotency-Key middleware
//
// Enforces a unique Idempotency-Key header on every POST request. Keys are
// persisted in Redis with a configurable TTL so that duplicate submissions
// within the window are rejected with 409.
//
// Header: Idempotency-Key: <opaque-string>
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'idempotency:';
const KEY_TTL_SECONDS = Number(process.env.IDEMPOTENCY_TTL_SECONDS) || 86400; // 24 h

let redisClient = null;

/**
 * Lazily initialise (and cache) an ioredis client using the existing Redis
 * config. BullMQ ships with ioredis, so it's always available as a transitive
 * dep without adding an explicit dependency.
 */
function getRedisClient() {
  if (redisClient) return redisClient;

  // ioredis is bundled with bullmq — no separate install needed.
  const Redis = require('ioredis');
  const opts = getRedisConnectionOptions();
  redisClient = new Redis({ ...opts, maxRetriesPerRequest: null });

  redisClient.on('error', (err) => {
    logger.error({ err: err.message }, '[idempotency] Redis client error');
  });

  return redisClient;
}

/**
 * Express middleware that enforces Idempotency-Key headers on POST requests.
 *
 * - Missing header           → 400
 * - Key already seen         → 409
 * - Redis unavailable        → 503  (fail-closed: reject rather than allow duplicates)
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function enforceIdempotency(req, res, next) {
  const key = req.headers['idempotency-key'];

  if (!key || String(key).trim() === '') {
    return res.status(400).json({
      error: 'Missing Idempotency-Key header',
      code: 'MISSING_IDEMPOTENCY_KEY',
    });
  }

  const redisKey = KEY_PREFIX + String(key).trim();

  try {
    const redis = getRedisClient();
    // SET NX EX — atomic: only sets the key if it doesn't already exist.
    const result = await redis.set(redisKey, '1', 'EX', KEY_TTL_SECONDS, 'NX');

    if (result === null) {
      logger.warn({ idempotencyKey: key, path: req.path }, '[idempotency] duplicate request rejected');
      return res.status(409).json({
        error: 'Duplicate request — this Idempotency-Key has already been processed',
        code: 'DUPLICATE_REQUEST',
      });
    }

    return next();
  } catch (err) {
    logger.error({ err: err.message, idempotencyKey: key }, '[idempotency] Redis error, rejecting request');
    return res.status(503).json({
      error: 'Service temporarily unavailable',
      code: 'IDEMPOTENCY_CHECK_FAILED',
    });
  }
}

module.exports = { enforceIdempotency };
