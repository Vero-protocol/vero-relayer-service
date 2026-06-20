const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildGitHubPullRequestEventPayload } = require('../src/queue');
const { logger } = require('../src/logger');
const { StellarServiceUnavailableError } = require('../src/services/stellar-errors');
const { processEventJob } = require('../src/workers/event-worker');

function job(data) {
  return {
    id: 'job-1',
    data,
    attemptsMade: 0,
    opts: {
      attempts: 5
    }
  };
}

test('processEventJob calls the existing transaction broadcasting logic', async () => {
  const calls = [];
  const payload = buildGitHubPullRequestEventPayload({
    action: 'closed',
    pull_request: {
      number: 42,
      merged: true,
      labels: [{ name: 'wave-contribution' }]
    }
  }, { deliveryId: 'delivery-worker' });

  const result = await processEventJob(job(payload), {
    registerTaskOnChain: async pullRequestNumber => {
      calls.push(pullRequestNumber);
    }
  });

  assert.deepEqual(calls, [42]);
  assert.deepEqual(result, { pr: 42 });
});

test('processEventJob rejects invalid jobs without calling broadcaster', async () => {
  const calls = [];
  const invalidPayload = {
    eventType: 'github.pull_request.merged',
    payload: {
      pull_request: {}
    }
  };

  await assert.rejects(
    () => processEventJob(job(invalidPayload), {
      registerTaskOnChain: async pullRequestNumber => {
        calls.push(pullRequestNumber);
      }
    }),
    /missing pull request number/
  );
  assert.deepEqual(calls, []);
});

test('processEventJob registers metrics with task_type label', async () => {
  const { vero_events_processed_total, queue_latency_seconds } = require('../src/metrics/metrics');

  const payload = buildGitHubPullRequestEventPayload({
    action: 'closed',
    pull_request: {
      number: 43,
      merged: true,
      labels: [{ name: 'wave-contribution' }]
    }
  }, { deliveryId: 'delivery-worker-2', receivedAt: new Date().toISOString() });

  const initialValue = await vero_events_processed_total.get();
  const initialCount = initialValue.values.find(v => v.labels.task_type === 'github.pull_request.merged')?.value || 0;

  await processEventJob(job(payload), {
    registerTaskOnChain: async () => {}
  });

  const afterValue = await vero_events_processed_total.get();
  const afterCount = afterValue.values.find(v => v.labels.task_type === 'github.pull_request.merged')?.value || 0;

  assert.equal(afterCount, initialCount + 1);

  const latencyValue = await queue_latency_seconds.get();
  const latencyVal = latencyValue.values.find(v => v.labels.task_type === 'github.pull_request.merged');
  assert.ok(latencyVal);
});

test('processEventJob logs Stellar service failures before returning the job failure', async () => {
  const errors = [];
  const originalError = logger.error;
  logger.error = (obj, msg) => {
    errors.push({ obj, msg });
  };

  const payload = buildGitHubPullRequestEventPayload({
    action: 'closed',
    pull_request: {
      number: 44,
      merged: true,
      labels: [{ name: 'wave-contribution' }]
    }
  }, { deliveryId: 'delivery-worker-3' });

  try {
    await assert.rejects(
      () => processEventJob(job(payload), {
        registerTaskOnChain: async () => {
          const cause = new Error(`Horizon request timed out ${'S' + 'A'.repeat(55)}`);
          cause.code = 'ETIMEDOUT';
          throw new StellarServiceUnavailableError('Stellar service temporarily unavailable', {
            cause,
            operation: 'submitTransaction'
          });
        }
      }),
      error => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.code, 'STELLAR_SERVICE_UNAVAILABLE');
        return true;
      }
    );
  } finally {
    logger.error = originalError;
  }

  assert.equal(errors.length, 1);
  assert.equal(errors[0].msg, '[worker] Stellar transaction submission failed');
  assert.equal(errors[0].obj.pr, 44);
  assert.equal(errors[0].obj.statusCode, 503);
  assert.equal(errors[0].obj.code, 'STELLAR_SERVICE_UNAVAILABLE');
  assert.equal(errors[0].obj.operation, 'submitTransaction');
  assert.equal(errors[0].obj.causeCode, 'ETIMEDOUT');
  assert.match(errors[0].obj.causeError, /\[Redacted\]/);
});
