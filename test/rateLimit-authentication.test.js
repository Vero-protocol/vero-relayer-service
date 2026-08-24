'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, test } = require('node:test');
const supertest = require('supertest');

const TEST_SECRET = 'rate-limit-authentication-test-secret';
const managedEnv = [
  'GITHUB_WEBHOOK_SECRET',
  'ALLOW_UNSIGNED_WEBHOOKS',
  'RATE_LIMIT_PUBLIC_MAX',
  'RATE_LIMIT_AUTH_MAX',
  'REDIS_HOST',
  'REDIS_PORT',
];
const previousEnv = Object.fromEntries(managedEnv.map(name => [name, process.env[name]]));

process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
process.env.RATE_LIMIT_PUBLIC_MAX = '1';
process.env.RATE_LIMIT_AUTH_MAX = '3';
// Keep this regression deterministic and isolated from shared CI Redis state.
delete process.env.REDIS_HOST;
delete process.env.REDIS_PORT;

const { createApp } = require('../index');

after(() => {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function buildTestApp() {
  return createApp({
    idempotencyMiddleware: (_req, _res, next) => next(),
    enqueueEventJob: async () => {
      throw new Error('non-qualifying test events must not be enqueued');
    },
  });
}

function payload() {
  return {
    action: 'opened',
    pull_request: { number: 200, merged: false, labels: [] },
  };
}

function sign(body) {
  return 'sha256=' + crypto
    .createHmac('sha256', TEST_SECRET)
    .update(JSON.stringify(body))
    .digest('hex');
}

test('garbage GitHub signatures consume the public tier before rejection', async () => {
  const app = buildTestApp();
  const body = payload();
  // Use a correctly shaped digest so this proves cryptographic validation,
  // rather than rejection based only on header syntax or length.
  const forgedSignature = `sha256=${'0'.repeat(64)}`;
  const request = () => supertest(app)
    .post('/github-webhook')
    .set('X-Forwarded-For', '198.51.100.200')
    .set('X-Hub-Signature-256', forgedSignature)
    .send(body);

  const first = await request();
  assert.equal(first.status, 401);
  assert.equal(first.headers['ratelimit-limit'], '1');
  assert.equal(first.headers['ratelimit-remaining'], '0');

  const second = await request();
  assert.equal(second.status, 429);
  assert.equal(second.body.code, 'RATE_LIMIT_EXCEEDED');
  assert.equal(second.headers['ratelimit-limit'], '1');
});

test('verified GitHub signatures retain the authenticated tier', async () => {
  const app = buildTestApp();
  const body = payload();
  const signature = sign(body);
  const request = () => supertest(app)
    .post('/github-webhook')
    .set('X-Forwarded-For', '198.51.100.201')
    .set('X-Hub-Signature-256', signature)
    .send(body);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal(response.headers['ratelimit-limit'], '3');
  }

  const limited = await request();
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMIT_EXCEEDED');
  assert.equal(limited.headers['ratelimit-limit'], '3');
});

test('authentication-looking headers cannot grant the authenticated tier', async () => {
  const app = buildTestApp();

  for (const [ip, header, value] of [
    ['198.51.100.202', 'Authorization', 'Bearer forged.token.value'],
    ['198.51.100.203', 'X-Vero-Signature', 'sha256=garbage'],
  ]) {
    const response = await supertest(app)
      .post('/github-webhook')
      .set('X-Forwarded-For', ip)
      .set(header, value)
      .send(payload());

    assert.equal(response.status, 401);
    assert.equal(response.headers['ratelimit-limit'], '1');
  }
});

test('explicit unsigned-webhook mode remains in the public tier', async () => {
  const app = buildTestApp();
  delete process.env.GITHUB_WEBHOOK_SECRET;
  process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';

  try {
    const request = () => supertest(app)
      .post('/github-webhook')
      .set('X-Forwarded-For', '198.51.100.204')
      .send(payload());

    const first = await request();
    assert.equal(first.status, 200);
    assert.equal(first.headers['ratelimit-limit'], '1');

    const second = await request();
    assert.equal(second.status, 429);
    assert.equal(second.body.code, 'RATE_LIMIT_EXCEEDED');
    assert.equal(second.headers['ratelimit-limit'], '1');
  } finally {
    process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
    delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
  }
});
