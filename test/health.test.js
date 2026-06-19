const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp } = require('../index');

function createReport(overrides = {}) {
  return {
    summary: {
      ok: overrides.ok !== false,
      checkedAt: '2026-06-20T00:00:00.000Z'
    },
    checks: {
      db: {
        status: overrides.redisStatus || 'ok',
        ok: overrides.redisOk !== false,
        latencyMs: 2,
        details: 'redis://:secret@example.internal:6379/0'
      },
      rpc: {
        status: overrides.rpcStatus || 'ok',
        ok: overrides.rpcOk !== false,
        latencyMs: 3,
        details: 'RPC responded with 200 from https://secret-token@example.internal'
      },
      disk: {
        status: overrides.diskStatus || 'ok',
        ok: overrides.diskOk !== false,
        details: '/private/service/path'
      }
    }
  };
}

test('health endpoint returns 200 with sanitized healthy status', async () => {
  const app = createApp({
    getHealthReport: async () => createReport()
  });

  const { response, body } = await getJson(app, '/health');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(body.status, 'healthy');
  assert.equal(body.checkedAt, '2026-06-20T00:00:00.000Z');
  assert.deepEqual(body.checks, {
    redis: { status: 'ok', ok: true, latencyMs: 2 },
    rpc: { status: 'ok', ok: true, latencyMs: 3 },
    disk: { status: 'ok', ok: true }
  });
  assert.equal(JSON.stringify(body).includes('secret'), false);
  assert.equal(JSON.stringify(body).includes('/private/service/path'), false);
});

test('health endpoint returns 503 when any dependency is degraded', async () => {
  const app = createApp({
    getHealthReport: async () => createReport({
      ok: false,
      redisStatus: 'error',
      redisOk: false
    })
  });

  const { response, body } = await getJson(app, '/health');

  assert.equal(response.status, 503);
  assert.equal(body.status, 'degraded');
  assert.equal(body.checks.redis.ok, false);
  assert.equal(body.checks.redis.status, 'error');
});

test('health endpoint returns 503 when checks throw', async () => {
  const app = createApp({
    getHealthReport: async () => {
      throw new Error('DATABASE_URL=postgres://secret@example.internal/db');
    }
  });

  const { response, body } = await getJson(app, '/health');

  assert.equal(response.status, 503);
  assert.equal(body.status, 'degraded');
  assert.deepEqual(body.checks, {
    health: {
      status: 'error',
      ok: false
    }
  });
  assert.equal(JSON.stringify(body).includes('secret'), false);
});

test('health endpoint returns 503 when checks exceed timeout', async () => {
  const app = createApp({
    healthCheckTimeoutMs: 5,
    getHealthReport: () => new Promise(resolve => setTimeout(() => resolve(createReport()), 100))
  });

  const { response, body } = await getJson(app, '/health');

  assert.equal(response.status, 503);
  assert.equal(body.status, 'degraded');
  assert.deepEqual(body.checks, {
    health: {
      status: 'error',
      ok: false
    }
  });
});

async function getJson(app, path) {
  const server = await new Promise(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    const body = await response.json();

    return { response, body };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
