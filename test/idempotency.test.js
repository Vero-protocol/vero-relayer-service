'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const supertest = require('supertest');

// ---------------------------------------------------------------------------
// Stub out ioredis before requiring the middleware so we don't need a real
// Redis instance in tests.
// ---------------------------------------------------------------------------

const redisCalls = [];
let nextSetResult = 'OK'; // 'OK' = key was new, null = key already existed

const fakeRedis = {
  set(...args) {
    redisCalls.push(args);
    return Promise.resolve(nextSetResult);
  },
  on() {},
};

// Intercept require('ioredis') inside the middleware module.
const Module = require('node:module');
const originalCompile = Module.prototype._compile;
// We stub at the module cache level — simplest approach for CommonJS.
require.cache[require.resolve('ioredis')] = {
  id: require.resolve('ioredis'),
  filename: require.resolve('ioredis'),
  loaded: true,
  exports: function FakeRedis() { return fakeRedis; },
};

// Force a fresh load of the middleware so it picks up the stub.
delete require.cache[require.resolve('../src/middleware/idempotency')];
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '6379';
const { enforceIdempotency } = require('../src/middleware/idempotency');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post('/tx', enforceIdempotency, (_req, res) => res.status(202).json({ ok: true }));
  return app;
}

function reset() {
  redisCalls.length = 0;
  nextSetResult = 'OK';
  // Clear the cached client so each test gets a fresh one
  delete require.cache[require.resolve('../src/middleware/idempotency')];
  const fresh = require('../src/middleware/idempotency');
  return fresh.enforceIdempotency;
}

// ---------------------------------------------------------------------------
// Unit tests – enforceIdempotency middleware
// ---------------------------------------------------------------------------

test('idempotency – rejects POST with missing Idempotency-Key header', async () => {
  const app = buildApp();

  const res = await supertest(app)
    .post('/tx')
    .send({ amount: 100 });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'MISSING_IDEMPOTENCY_KEY');
});

test('idempotency – rejects POST with blank Idempotency-Key header', async () => {
  const app = buildApp();

  const res = await supertest(app)
    .post('/tx')
    .set('Idempotency-Key', '   ')
    .send({ amount: 100 });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'MISSING_IDEMPOTENCY_KEY');
});

test('idempotency – allows a new unique key through (Redis SET NX returns OK)', async () => {
  nextSetResult = 'OK';
  const app = buildApp();

  const res = await supertest(app)
    .post('/tx')
    .set('Idempotency-Key', 'unique-key-abc123')
    .send({ amount: 100 });

  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { ok: true });
});

test('idempotency – rejects duplicate key (Redis SET NX returns null)', async () => {
  nextSetResult = null; // simulate key already present
  const app = buildApp();

  const res = await supertest(app)
    .post('/tx')
    .set('Idempotency-Key', 'already-seen-key')
    .send({ amount: 100 });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'DUPLICATE_REQUEST');
});

test('idempotency – stores key with NX and EX flags in Redis', async () => {
  nextSetResult = 'OK';
  redisCalls.length = 0;
  const app = buildApp();

  await supertest(app)
    .post('/tx')
    .set('Idempotency-Key', 'check-redis-args')
    .send({});

  assert.equal(redisCalls.length, 1);
  const [, , flag, , mode] = redisCalls[0];
  assert.equal(flag, 'EX');
  assert.equal(mode, 'NX');
});

test('idempotency – returns 503 when Redis throws', async () => {
  // Override the fake to throw
  const brokenRedis = {
    set() { return Promise.reject(new Error('connection refused')); },
    on() {},
  };
  require.cache[require.resolve('ioredis')] = {
    id: require.resolve('ioredis'),
    filename: require.resolve('ioredis'),
    loaded: true,
    exports: function FakeRedis() { return brokenRedis; },
  };
  delete require.cache[require.resolve('../src/middleware/idempotency')];
  const { enforceIdempotency: middleware } = require('../src/middleware/idempotency');

  const app = express();
  app.use(express.json());
  app.post('/tx', middleware, (_req, res) => res.status(202).json({ ok: true }));

  const res = await supertest(app)
    .post('/tx')
    .set('Idempotency-Key', 'key-redis-down')
    .send({});

  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'IDEMPOTENCY_CHECK_FAILED');

  // Restore working fake
  require.cache[require.resolve('ioredis')] = {
    id: require.resolve('ioredis'),
    filename: require.resolve('ioredis'),
    loaded: true,
    exports: function FakeRedis() { return fakeRedis; },
  };
  delete require.cache[require.resolve('../src/middleware/idempotency')];
  require('../src/middleware/idempotency');
});
