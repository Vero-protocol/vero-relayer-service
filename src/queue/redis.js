require('dotenv').config();

const DEFAULT_QUEUE_NAME = 'vero:event-processing';
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_RETRY_ATTEMPTS = 5;
const DEFAULT_RETRY_BACKOFF_DELAY = 5000;

function requireValue(name, value) {
  if (!value || String(value).trim() === '') {
    throw new Error(`${name} is required for Redis event queue configuration`);
  }

  return String(value).trim();
}

function parseRedisPort(value) {
  const port = Number(requireValue('REDIS_PORT', value));

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('REDIS_PORT must be a valid TCP port');
  }

  return port;
}

function parseBoolean(value) {
  return String(value || '').toLowerCase() === 'true';
}

function getEventQueueName(env = process.env) {
  return env.EVENT_QUEUE_NAME || DEFAULT_QUEUE_NAME;
}

function getBullMqQueueSettings(queueName = DEFAULT_QUEUE_NAME) {
  const parts = String(queueName).split(':').filter(Boolean);

  if (parts.length === 0) {
    throw new Error('EVENT_QUEUE_NAME must not be empty');
  }

  if (parts.length === 1) {
    return {
      name: parts[0],
      prefix: 'bull'
    };
  }

  return {
    name: parts[parts.length - 1],
    prefix: `bull:${parts.slice(0, -1).join(':')}`
  };
}

function getEventQueueConcurrency(env = process.env) {
  const rawConcurrency = env.EVENT_QUEUE_CONCURRENCY;

  if (!rawConcurrency) {
    return DEFAULT_CONCURRENCY;
  }

  const concurrency = Number(rawConcurrency);

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('EVENT_QUEUE_CONCURRENCY must be a positive integer');
  }

  return concurrency;
}

function getRedisConnectionOptions(env = process.env) {
  const host = requireValue('REDIS_HOST', env.REDIS_HOST);
  const port = parseRedisPort(env.REDIS_PORT);
  const password = env.REDIS_PASSWORD ? String(env.REDIS_PASSWORD) : undefined;

  if (env.NODE_ENV === 'production' && !password) {
    throw new Error('REDIS_PASSWORD is required in production');
  }

  const connection = {
    host,
    port,
    maxRetriesPerRequest: null
  };

  if (env.REDIS_USERNAME) {
    connection.username = String(env.REDIS_USERNAME);
  }

  if (password) {
    connection.password = password;
  }

  if (parseBoolean(env.REDIS_TLS)) {
    connection.tls = {};
  }

  return connection;
}

function getEventQueueRetryAttempts(env = process.env) {
  const rawAttempts = env.EVENT_QUEUE_RETRY_ATTEMPTS;

  if (!rawAttempts) {
    return DEFAULT_RETRY_ATTEMPTS;
  }

  const attempts = Number(rawAttempts);

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('EVENT_QUEUE_RETRY_ATTEMPTS must be a positive integer');
  }

  return attempts;
}

function getEventQueueRetryBackoffDelay(env = process.env) {
  const rawDelay = env.EVENT_QUEUE_RETRY_BACKOFF_DELAY;

  if (!rawDelay) {
    return DEFAULT_RETRY_BACKOFF_DELAY;
  }

  const delay = Number(rawDelay);

  if (!Number.isInteger(delay) || delay < 1) {
    throw new Error('EVENT_QUEUE_RETRY_BACKOFF_DELAY must be a positive integer (milliseconds)');
  }

  return delay;
}

function validateRedisConfig(env = process.env) {
  getRedisConnectionOptions(env);
  getEventQueueConcurrency(env);
  getBullMqQueueSettings(getEventQueueName(env));
  getEventQueueRetryAttempts(env);
  getEventQueueRetryBackoffDelay(env);
}

module.exports = {
  DEFAULT_CONCURRENCY,
  DEFAULT_QUEUE_NAME,
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BACKOFF_DELAY,
  getBullMqQueueSettings,
  getEventQueueConcurrency,
  getEventQueueName,
  getEventQueueRetryAttempts,
  getEventQueueRetryBackoffDelay,
  getRedisConnectionOptions,
  validateRedisConfig
};
