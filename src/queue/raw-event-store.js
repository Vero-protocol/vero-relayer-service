'use strict';

const Redis = require('ioredis');
const { getRedisConnectionOptions } = require('./redis');
const { deriveIdempotencyKey } = require('./event-queue');

const DEFAULT_RETENTION_DAYS = 7;
const RAW_EVENT_KEY_PREFIX = 'vero:webhook:raw-event:';

function getPayloadRetentionSeconds(env = process.env) {
  const value = env.EVENT_PAYLOAD_RETENTION_DAYS;
  const days = value === undefined || value === null ? DEFAULT_RETENTION_DAYS : Number(value);

  if (!Number.isInteger(days) || days < 1) {
    return DEFAULT_RETENTION_DAYS * 24 * 60 * 60;
  }

  return days * 24 * 60 * 60;
}

function buildRawEventStoreKey(idempotencyKey) {
  return `${RAW_EVENT_KEY_PREFIX}${encodeURIComponent(String(idempotencyKey))}`;
}

function createRedisClient(options = {}) {
  return new Redis(options.connection || getRedisConnectionOptions(options.env));
}

async function storeRawEvent(rawEvent, metadata = {}, options = {}) {
  const idempotencyKey = deriveIdempotencyKey(rawEvent, metadata);

  if (!idempotencyKey) {
    throw new Error('Could not derive idempotency key for raw event');
  }

  const redis = options.redis || createRedisClient(options);
  const ownClient = !options.redis;

  try {
    const key = buildRawEventStoreKey(idempotencyKey);
    const payload = JSON.stringify({ rawEvent, metadata, storedAt: new Date().toISOString() });
    const ttl = getPayloadRetentionSeconds(options.env);

    await redis.set(key, payload, 'EX', ttl);
    return idempotencyKey;
  } finally {
    if (ownClient) {
      redis.disconnect();
    }
  }
}

async function fetchRawEvent(idempotencyKey, options = {}) {
  if (!idempotencyKey) {
    return null;
  }

  const redis = options.redis || createRedisClient(options);
  const ownClient = !options.redis;

  try {
    const key = buildRawEventStoreKey(idempotencyKey);
    const rawValue = await redis.get(key);

    if (!rawValue) {
      return null;
    }

    return JSON.parse(rawValue);
  } finally {
    if (ownClient) {
      redis.disconnect();
    }
  }
}

module.exports = {
  storeRawEvent,
  fetchRawEvent,
  getPayloadRetentionSeconds,
  buildRawEventStoreKey
};
