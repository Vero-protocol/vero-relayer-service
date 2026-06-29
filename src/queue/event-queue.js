const crypto = require('crypto');
const { Queue } = require('bullmq');
const { EVENT_TYPES } = require('./types');
const {
  getBullMqQueueSettings,
  getEventQueueName,
  getRedisConnectionOptions,
  getEventQueueRetryAttempts,
  getEventQueueRetryBackoffDelay
} = require('./redis');

const EVENT_JOB_NAME = 'process-event';

function getDefaultJobOptions(env = process.env) {
  return Object.freeze({
    attempts: getEventQueueRetryAttempts(env),
    backoff: {
      type: 'exponential',
      delay: getEventQueueRetryBackoffDelay(env)
    },
    removeOnComplete: {
      age: 24 * 60 * 60,
      count: 1000
    },
    removeOnFail: {
      age: 7 * 24 * 60 * 60,
      count: 5000
    }
  });
}

const DEFAULT_JOB_OPTIONS = getDefaultJobOptions();

let eventQueue;

function createEventQueue(options = {}) {
  const settings = getBullMqQueueSettings(options.queueName || getEventQueueName(options.env));

  return new Queue(settings.name, {
    connection: options.connection || getRedisConnectionOptions(options.env),
    defaultJobOptions: getDefaultJobOptions(options.env),
    prefix: settings.prefix
  });
}

function getEventQueue() {
  if (!eventQueue) {
    eventQueue = createEventQueue();
  }

  return eventQueue;
}

function getHeader(req, name) {
  if (!req || typeof req.get !== 'function') {
    return null;
  }

  return req.get(name) || null;
}

function sanitizeLabel(label) {
  return {
    id: label && label.id,
    name: String((label && label.name) || '')
  };
}

function sanitizeRepository(repository) {
  if (!repository) {
    return null;
  }

  return {
    id: repository.id,
    name: repository.name,
    full_name: repository.full_name
  };
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }

  return null;
}

function deriveIdempotencyKey(rawEvent = {}, metadata = {}) {
  const pr = rawEvent.pull_request || {};
  const repository = rawEvent.repository || {};
  const repositoryKey = firstNonEmptyString([repository.full_name, repository.id]);
  const prKey = firstNonEmptyString([pr.node_id, pr.id, pr.number]);

  return firstNonEmptyString([
    metadata.idempotencyKey,
    metadata.deliveryId,
    rawEvent.idempotency_key,
    rawEvent.webhook_id,
    rawEvent.event_id,
    rawEvent.transaction_id,
    repositoryKey && prKey ? `github:pull_request:${repositoryKey}:${prKey}:merged` : null,
    prKey ? `github:pull_request:unknown-repository:${prKey}:merged` : null
  ]);
}

function buildGitHubPullRequestEventPayload(rawEvent, metadata = {}) {
  const pr = (rawEvent && rawEvent.pull_request) || {};
  const labels = Array.isArray(pr.labels) ? pr.labels.map(sanitizeLabel).filter(label => label.name) : [];
  const idempotencyKey = deriveIdempotencyKey(rawEvent, metadata);

  return {
    eventType: EVENT_TYPES.GITHUB_PULL_REQUEST_MERGED,
    receivedAt: metadata.receivedAt || new Date().toISOString(),
    requestId: metadata.requestId || null,
    source: metadata.source || 'github',
    idempotencyKey,
    payload: {
      action: rawEvent.action,
      pull_request: {
        id: pr.id,
        node_id: pr.node_id,
        number: pr.number,
        merged: pr.merged === true,
        labels
      },
      repository: sanitizeRepository(rawEvent.repository)
    }
  };
}

function buildMetadataFromRequest(req) {
  return {
    deliveryId: getHeader(req, 'x-github-delivery'),
    idempotencyKey: getHeader(req, 'idempotency-key') || getHeader(req, 'x-github-delivery'),
    requestId: getHeader(req, 'x-request-id'),
    source: 'github'
  };
}

function createEventJobId(eventPayload) {
  if (eventPayload && eventPayload.idempotencyKey) {
    // This repository has no durable broadcast ledger, so duplicate safety is
    // queue-level: a stable BullMQ jobId prevents duplicate queued jobs while
    // Redis still retains the matching job.
    return `event-${crypto.createHash('sha256').update(eventPayload.idempotencyKey).digest('hex')}`;
  }

  return `event-${crypto.randomUUID()}`;
}

async function enqueueEvent(eventPayload, options = {}) {
  const queue = options.queue || getEventQueue();
  const jobId = options.jobId || createEventJobId(eventPayload);

  return queue.add(EVENT_JOB_NAME, eventPayload, {
    jobId
  });
}

async function closeEventQueue() {
  if (eventQueue) {
    await eventQueue.close();
    eventQueue = null;
  }
}

module.exports = {
  DEFAULT_JOB_OPTIONS,
  EVENT_JOB_NAME,
  buildGitHubPullRequestEventPayload,
  buildMetadataFromRequest,
  closeEventQueue,
  createEventJobId,
  createEventQueue,
  deriveIdempotencyKey,
  enqueueEvent,
  getEventQueue
};
