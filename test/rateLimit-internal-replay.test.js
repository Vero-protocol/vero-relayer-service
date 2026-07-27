'use strict';

const assert  = require('node:assert/strict');
const { test, after } = require('node:test');
const crypto  = require('node:crypto');

// CRITICAL: Set the env BEFORE any `require('../index')` so the rate
// limiter, JWT middleware and JWT service all see the tightened values when
// the module graphs are first evaluated. This avoids the brittle
// require.cache hacking that previous attempts relied on.
process.env.RATE_LIMIT_AUTH_MAX    = '2';
process.env.JWT_SIGNING_SECRET     = 'test-jwt-secret-32-chars-long-0000000000';
process.env.JWT_ISSUER             = 'vero-relayer-service';

const supertest  = require('supertest');
const { createApp } = require('../index');
const { signJwt }   = require('../src/services/jwt');

const TEST_REPLAY_IP = '203.0.113.50';

// Restore env so sibling test files loaded in the same process see the
// project defaults rather than the tightened values from this file.
after(() => {
  delete process.env.RATE_LIMIT_AUTH_MAX;
  delete process.env.JWT_SIGNING_SECRET;
  delete process.env.JWT_ISSUER;
});

test('/internal/webhooks/replay enforces rate limiting (429 beyond configured limit)', async () => {
  const jwt = signJwt(
    { sub: 'rate-limit-test', role: 'internal' },
    { expiresInSeconds: 60 }
  );

  const rawEvent = {
    action: 'closed',
    pull_request: { number: 7, merged: true, labels: [{ name: 'wave-contribution' }] },
    repository: { id: 7, full_name: 'x/y' }
  };

  const app = createApp({
    fetchRawEvent: async key => ({
      rawEvent,
      metadata: { deliveryId: key, requestId: key, receivedAt: new Date().toISOString() }
    }),
    enqueueEventJob: async () => ({ id: 'job-replay-rate-limit' })
  });

  const replayRequest = () =>
    supertest(app)
      .post('/internal/webhooks/replay')
      .set('X-Forwarded-For', TEST_REPLAY_IP)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ idempotencyKey: crypto.randomUUID() });

  // With RATE_LIMIT_AUTH_MAX=2, the first two authenticated requests from
  // the same IP must succeed (202).
  const first = await replayRequest();
  assert.equal(first.status, 202);

  const second = await replayRequest();
  assert.equal(second.status, 202);

  // The third request exceeds the limit and must be denied with 429.
  const third = await replayRequest();
  assert.equal(third.status, 429);
  assert.equal(third.body.code, 'RATE_LIMIT_EXCEEDED');
});
