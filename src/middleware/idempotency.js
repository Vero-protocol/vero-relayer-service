'use strict';

const { getRedisConnectionOptions } = require('../queue/redis');
const { resolveIdempotencyKeyFromRequest } = require('../queue/event-queue');
const { logger } = require('../logger');
const { sendError } = require('../utils/http-errors');

// ---------------------------------------------------------------------------
// Idempotency-Key middleware
//
// Enforces a unique idempotency key on every POST request. Keys are
// persisted in Redis with a configurable TTL so that duplicate submissions
// within the window are rejected with 409.
//
// Accepted headers (same fallback as buildMetadataFromRequest):
//   Idempotency-Key: <opaque-string>
//   X-GitHub-Delivery: <uuid>   (used when Idempotency-Key is absent)
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
 * Express middleware that enforces idempotency keys on POST requests.
 *
 * - Missing Idempotency-Key and X-GitHub-Delivery → 400
 * - Key already seen                              → 409
 * - Redis unavailable                             → 503  (fail-closed: reject rather than allow duplicates)
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function enforceIdempotency(req, res, next) {
  const key = resolveIdempotencyKeyFromRequest(req);

  if (!key) {
    return sendError(
      res,
      400,
      'MISSING_IDEMPOTENCY_KEY',
      'Missing Idempotency-Key or X-GitHub-Delivery header'
    );
  }

  const redisKey = KEY_PREFIX + key;

  try {
    const redis = getRedisClient();
    // SET NX EX — atomic: only sets the key if it doesn't already exist.
    const result = await redis.set(redisKey, '1', 'EX', KEY_TTL_SECONDS, 'NX');

    if (result === null) {
      logger.warn({ idempotencyKey: key, path: req.path }, '[idempotency] duplicate request rejected');
      return sendError(res, 409, 'DUPLICATE_REQUEST', 'Duplicate request — this Idempotency-Key has already been processed');
    }

    return next();
  } catch (err) {
    logger.error({ err: err.message, idempotencyKey: key }, '[idempotency] Redis error, rejecting request');
    return sendError(res, 503, 'IDEMPOTENCY_CHECK_FAILED', 'Service temporarily unavailable');
  }
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

module.exports = { enforceIdempotency, closeRedisClient };
