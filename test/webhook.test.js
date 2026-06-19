const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const { createApp } = require('../index');

const TEST_SECRET = 'test-webhook-secret';

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', TEST_SECRET).update(body).digest('hex');
}

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve(server));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function url(server, path) {
  return `http://127.0.0.1:${server.address().port}${path}`;
}

test('github webhook enqueues qualifying events instead of broadcasting synchronously', async t => {
  process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
  t.after(() => delete process.env.GITHUB_WEBHOOK_SECRET);

  const enqueuedEvents = [];
  const app = createApp({
    enqueueEventJob: async eventPayload => {
      enqueuedEvents.push(eventPayload);
      return { id: 'job-42' };
    }
  });
  const server = await listen(app);
  t.after(() => close(server));

  const body = JSON.stringify({
    action: 'closed',
    pull_request: {
      number: 42,
      merged: true,
      labels: [{ name: 'wave-contribution' }]
    }
  });

  const response = await fetch(url(server, '/github-webhook'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Delivery': 'delivery-route',
      'X-Request-ID': 'request-route',
      'x-hub-signature-256': sign(body)
    },
    body
  });

  const resBody = await response.json();

  assert.equal(response.status, 202);
  assert.deepEqual(resBody, { ok: true, pr: 42, queued: true, jobId: 'job-42' });
  assert.equal(enqueuedEvents.length, 1);
  assert.equal(enqueuedEvents[0].payload.pull_request.number, 42);
  assert.equal(enqueuedEvents[0].idempotencyKey, 'delivery-route');
  assert.equal(enqueuedEvents[0].requestId, 'request-route');
});

test('github webhook keeps existing skipped response for non-qualifying events', async t => {
  process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
  t.after(() => delete process.env.GITHUB_WEBHOOK_SECRET);

  const app = createApp({
    enqueueEventJob: async () => {
      throw new Error('should not enqueue skipped events');
    }
  });
  const server = await listen(app);
  t.after(() => close(server));

  const body = JSON.stringify({
    action: 'opened',
    pull_request: { number: 42, merged: false, labels: [] }
  });

  const response = await fetch(url(server, '/github-webhook'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': sign(body)
    },
    body
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { skipped: true });
});

test('github webhook rejects requests with invalid signature', async t => {
  process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
  t.after(() => delete process.env.GITHUB_WEBHOOK_SECRET);

  const app = createApp({
    enqueueEventJob: async () => { throw new Error('should not reach enqueue'); }
  });
  const server = await listen(app);
  t.after(() => close(server));

  const body = JSON.stringify({ action: 'closed', pull_request: { number: 1, merged: true, labels: [] } });

  const response = await fetch(url(server, '/github-webhook'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': 'sha256=invalidsignature'
    },
    body
  });

  assert.equal(response.status, 401);
});

test('github webhook rejects requests with missing signature', async t => {
  process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
  t.after(() => delete process.env.GITHUB_WEBHOOK_SECRET);

  const app = createApp({
    enqueueEventJob: async () => { throw new Error('should not reach enqueue'); }
  });
  const server = await listen(app);
  t.after(() => close(server));

  const response = await fetch(url(server, '/github-webhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'closed' })
  });

  assert.equal(response.status, 401);
});

test('github webhook returns 503 when enqueue infrastructure is unavailable', async t => {
  process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
  t.after(() => delete process.env.GITHUB_WEBHOOK_SECRET);

  const app = createApp({
    enqueueEventJob: async () => {
      const error = new Error('Redis connection timed out');
      error.code = 'ETIMEDOUT';
      throw error;
    }
  });
  const server = await listen(app);
  t.after(() => close(server));

  const body = JSON.stringify({
    action: 'closed',
    pull_request: {
      number: 42,
      merged: true,
      labels: [{ name: 'wave-contribution' }]
    }
  });

  const response = await fetch(url(server, '/github-webhook'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': sign(body)
    },
    body
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: 'service unavailable' });
});
