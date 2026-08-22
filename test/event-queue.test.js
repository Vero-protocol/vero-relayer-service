const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  DEFAULT_JOB_OPTIONS,
  buildGitHubPullRequestEventPayload,
  createEventJobId,
  enqueueEvent
} = require('../src/queue');
const {
  getBullMqQueueSettings,
  getEventQueueConcurrency,
  getRedisConnectionOptions
} = require('../src/queue/redis');

function githubEvent(number, labels = [{ id: 1, name: 'wave-contribution' }]) {
  return {
    action: 'closed',
    pull_request: {
      id: number + 1000,
      node_id: `PR_${number}`,
      number,
      merged: true,
      labels
    },
    repository: {
      id: 123,
      name: 'vero-relayer-service',
      full_name: 'Vero-protocol/vero-relayer-service'
    },
    sender: {
      login: 'ignored-user'
    }
  };
}

test('buildGitHubPullRequestEventPayload keeps the queue payload small and safe', () => {
  const payload = buildGitHubPullRequestEventPayload(githubEvent(42), {
    deliveryId: 'delivery-42',
    requestId: 'request-42',
    source: 'github'
  });

  assert.equal(payload.eventType, 'github.pull_request.merged');
  assert.equal(payload.requestId, 'request-42');
  assert.equal(payload.source, 'github');
  assert.equal(payload.idempotencyKey, 'delivery-42');
  assert.equal(payload.payload.pull_request.number, 42);
  assert.equal(payload.payload.pull_request.merged, true);
  assert.deepEqual(payload.payload.pull_request.labels, [{ id: 1, name: 'wave-contribution' }]);
  assert.equal(payload.payload.repository.full_name, 'Vero-protocol/vero-relayer-service');
  assert.equal(payload.payload.sender, undefined);
});

test('buildMetadataFromRequest falls back to X-GitHub-Delivery for idempotency', () => {
  const { buildMetadataFromRequest, resolveIdempotencyKeyFromRequest } = require('../src/queue/event-queue');
  const req = {
    get(name) {
      const headers = {
        'x-github-delivery': 'delivery-from-github',
        'x-request-id': 'req-1'
      };
      return headers[String(name).toLowerCase()] || undefined;
    }
  };

  assert.equal(resolveIdempotencyKeyFromRequest(req), 'delivery-from-github');
  assert.deepEqual(buildMetadataFromRequest(req), {
    deliveryId: 'delivery-from-github',
    idempotencyKey: 'delivery-from-github',
    requestId: 'req-1',
    source: 'github'
  });
});

test('stable idempotency keys produce stable BullMQ job IDs', () => {
  const first = buildGitHubPullRequestEventPayload(githubEvent(42), { deliveryId: 'same-delivery' });
  const second = buildGitHubPullRequestEventPayload(githubEvent(42), { deliveryId: 'same-delivery' });

  assert.equal(createEventJobId(first), createEventJobId(second));
});

test('enqueueEvent adds a durable BullMQ event job', async () => {
  const addedJobs = [];
  const fakeQueue = {
    add: async (name, data, options) => {
      addedJobs.push({ name, data, options });
      return { id: options.jobId };
    }
  };
  const payload = buildGitHubPullRequestEventPayload(githubEvent(43), { deliveryId: 'delivery-43' });
  const job = await enqueueEvent(payload, { queue: fakeQueue });

  assert.equal(addedJobs.length, 1);
  assert.equal(addedJobs[0].name, 'process-event');
  assert.equal(addedJobs[0].data.payload.pull_request.number, 43);
  assert.equal(addedJobs[0].options.jobId, createEventJobId(payload));
  assert.equal(job.id, createEventJobId(payload));
  assert.equal(DEFAULT_JOB_OPTIONS.attempts, 5);
  assert.equal(DEFAULT_JOB_OPTIONS.backoff.type, 'exponential');
  assert.equal(DEFAULT_JOB_OPTIONS.removeOnComplete.count, 1000);
  assert.equal(DEFAULT_JOB_OPTIONS.removeOnFail.count, 5000);
});

test('100+ events can be enqueued without dropping jobs', async () => {
  const addedJobs = [];
  const fakeQueue = {
    add: async (name, data, options) => {
      addedJobs.push({ name, data, options });
      return { id: options.jobId };
    }
  };

  for (let index = 0; index < 125; index += 1) {
    const payload = buildGitHubPullRequestEventPayload(githubEvent(index + 1), {
      deliveryId: `delivery-${index + 1}`
    });
    await enqueueEvent(payload, { queue: fakeQueue });
  }

  const uniqueJobIds = new Set(addedJobs.map(job => job.options.jobId));
  assert.equal(addedJobs.length, 125);
  assert.equal(uniqueJobIds.size, 125);
});

test('Redis connection supports password, username, TLS, and production password validation', () => {
  const connection = getRedisConnectionOptions({
    NODE_ENV: 'production',
    REDIS_HOST: 'redis.internal',
    REDIS_PORT: '6380',
    REDIS_USERNAME: 'default',
    REDIS_PASSWORD: 'secret',
    REDIS_TLS: 'true'
  });

  assert.equal(connection.host, 'redis.internal');
  assert.equal(connection.port, 6380);
  assert.equal(connection.username, 'default');
  assert.equal(connection.password, 'secret');
  assert.deepEqual(connection.tls, {});
  assert.equal(connection.maxRetriesPerRequest, null);
  assert.throws(
    () => getRedisConnectionOptions({ NODE_ENV: 'production', REDIS_HOST: 'redis.internal', REDIS_PORT: '6379' }),
    /REDIS_PASSWORD is required in production/
  );
  assert.throws(() => getRedisConnectionOptions({ REDIS_PORT: '6379' }), /REDIS_HOST is required/);
  assert.equal(getEventQueueConcurrency({ EVENT_QUEUE_CONCURRENCY: '7' }), 7);
  assert.throws(() => getEventQueueConcurrency({ EVENT_QUEUE_CONCURRENCY: '0' }), /positive integer/);
});

test('colon-delimited logical queue names map to BullMQ-safe queue settings', () => {
  assert.deepEqual(getBullMqQueueSettings('vero:event-processing'), {
    name: 'event-processing',
    prefix: 'bull:vero'
  });
  assert.deepEqual(getBullMqQueueSettings('event-processing'), {
    name: 'event-processing',
    prefix: 'bull'
  });
});
