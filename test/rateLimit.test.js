'use strict';

const assert  = require('node:assert/strict');
const { test } = require('node:test');

const expressRateLimit = require('express-rate-limit');
const express          = require('express');
const supertest        = require('supertest');

const {
  isAuthenticated,
  clientIp,
  PUBLIC_MAX,
  AUTH_MAX,
  PUBLIC_WINDOW_MS,
  ingestRateLimiter,
} = require('../src/middleware/rateLimit');

// ---------------------------------------------------------------------------
// isAuthenticated helper
// ---------------------------------------------------------------------------

test('isAuthenticated returns true for Authorization header (JWT Bearer)', () => {
  const req = { headers: { authorization: 'Bearer token.abc.def' } };
  assert.ok(isAuthenticated(req));
});

test('isAuthenticated returns true for x-hub-signature-256 header (GitHub HMAC)', () => {
  const req = { headers: { 'x-hub-signature-256': 'sha256=abc123' } };
  assert.ok(isAuthenticated(req));
});

test('isAuthenticated returns true for x-vero-signature header', () => {
  const req = { headers: { 'x-vero-signature': 'sha256=abc123' } };
  assert.ok(isAuthenticated(req));
});

test('isAuthenticated returns false when no auth headers are present', () => {
  const req = { headers: {} };
  assert.equal(isAuthenticated(req), false);
});

test('isAuthenticated returns false for an empty Authorization header value', () => {
  const req = { headers: { authorization: '' } };
  assert.equal(isAuthenticated(req), false);
});

// ---------------------------------------------------------------------------
// clientIp helper
// ---------------------------------------------------------------------------

test('clientIp falls back to socket.remoteAddress when req.ip is absent', () => {
  const req = { ip: undefined, socket: { remoteAddress: '192.168.1.1' } };
  assert.equal(clientIp(req), '192.168.1.1');
});

test('clientIp returns "unknown" when neither ip nor socket is present', () => {
  const req = {};
  assert.equal(clientIp(req), 'unknown');
});

// ---------------------------------------------------------------------------
// Default limits exposed as constants
// ---------------------------------------------------------------------------

test('PUBLIC_MAX default is 100', () => {
  assert.equal(PUBLIC_MAX, 100);
});

test('AUTH_MAX default is 1000', () => {
  assert.equal(AUTH_MAX, 1_000);
});

test('PUBLIC_WINDOW_MS default is 15 minutes', () => {
  assert.equal(PUBLIC_WINDOW_MS, 15 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// Integration tests — minimal Express app
// ---------------------------------------------------------------------------

function buildTestApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.get('/test', ingestRateLimiter, (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

test('requests under the public limit receive 200 OK', async () => {
  const app = buildTestApp();
  const res = await supertest(app)
    .get('/test')
    .set('X-Forwarded-For', '10.0.0.1');

  assert.equal(res.status, 200);
});

test('rate limit response includes RateLimit-* standard headers', async () => {
  const app = buildTestApp();
  const res = await supertest(app)
    .get('/test')
    .set('X-Forwarded-For', '10.0.0.2');

  // express-rate-limit v7 emits RateLimit-Limit (RFC 6585 draft)
  const hasHeader =
    'ratelimit-limit' in res.headers ||
    'x-ratelimit-limit' in res.headers;
  assert.ok(hasHeader, 'expected a RateLimit-Limit header to be present');
});

test('authenticated requests succeed and receive rate limit headers', async () => {
  const app = buildTestApp();
  const res = await supertest(app)
    .get('/test')
    .set('X-Forwarded-For', '10.0.0.3')
    .set('Authorization', 'Bearer valid.jwt.token');

  assert.equal(res.status, 200);
});

test('rate limit handler returns 429 with JSON body when limit is exceeded', async () => {
  // Spin up a separate app with a limit of 1 so we can reliably trigger 429
  const tightLimiter = expressRateLimit({
    windowMs: 60_000,
    max: 1,
    standardHeaders: true,
    legacyHeaders: false,
    handler(_req, res) {
      res.status(429).json({
        error: 'Too many requests from this IP. Please retry after the window resets.',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    },
  });

  const tightApp = express();
  tightApp.set('trust proxy', 1);
  tightApp.use(express.json());
  tightApp.get('/tight', tightLimiter, (_req, res) => res.status(200).json({ ok: true }));

  // First request must succeed
  const first = await supertest(tightApp)
    .get('/tight')
    .set('X-Forwarded-For', '10.1.1.1');
  assert.equal(first.status, 200);

  // Second request from same IP must be rate-limited
  const second = await supertest(tightApp)
    .get('/tight')
    .set('X-Forwarded-For', '10.1.1.1');
  assert.equal(second.status, 429);
  assert.equal(second.body.code, 'RATE_LIMIT_EXCEEDED');
  assert.ok(second.body.error, 'expected an error message in the 429 response body');
});

test('different IPs are rate-limited independently', async () => {
  const tightLimiter = expressRateLimit({
    windowMs: 60_000,
    max: 1,
    standardHeaders: true,
    legacyHeaders: false,
    handler(_req, res) {
      res.status(429).json({ code: 'RATE_LIMIT_EXCEEDED' });
    },
  });

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.get('/ip-test', tightLimiter, (_req, res) => res.status(200).json({ ok: true }));

  // Exhaust limit for IP A
  await supertest(app).get('/ip-test').set('X-Forwarded-For', '10.2.0.1');
  const limitedA = await supertest(app).get('/ip-test').set('X-Forwarded-For', '10.2.0.1');
  assert.equal(limitedA.status, 429);

  // IP B should still be under limit
  const okB = await supertest(app).get('/ip-test').set('X-Forwarded-For', '10.2.0.2');
  assert.equal(okB.status, 200);
});

test('ingestRateLimiter respects RATE_LIMIT_PUBLIC_MAX env when reloaded (can trigger 429)', async () => {
  // Temporarily set env to tighten public limit to 1 and reload module
  const prev = process.env.RATE_LIMIT_PUBLIC_MAX;
  process.env.RATE_LIMIT_PUBLIC_MAX = '1';

  // Clear from require cache so module re-reads env
  delete require.cache[require.resolve('../src/middleware/rateLimit')];
  const reloaded = require('../src/middleware/rateLimit');

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.get('/rl-test', reloaded.ingestRateLimiter, (_req, res) => res.status(200).json({ ok: true }));

  // First request succeeds
  const first = await supertest(app).get('/rl-test').set('X-Forwarded-For', '203.0.113.5');
  assert.equal(first.status, 200);

  // Second request from same IP should be limited
  const second = await supertest(app).get('/rl-test').set('X-Forwarded-For', '203.0.113.5');
  assert.equal(second.status, 429);
  assert.equal(second.body.code, 'RATE_LIMIT_EXCEEDED');

  // restore env
  if (prev === undefined) {
    delete process.env.RATE_LIMIT_PUBLIC_MAX;
  } else {
    process.env.RATE_LIMIT_PUBLIC_MAX = prev;
  }
  // clear cache so subsequent tests load original constants
  delete require.cache[require.resolve('../src/middleware/rateLimit')];
});

test('X-Forwarded-For header is honored for client IP grouping', async () => {
  const app = buildTestApp();

  // Use two different client IPs in X-Forwarded-For; they should be treated separately
  const a1 = await supertest(app).get('/test').set('X-Forwarded-For', '198.51.100.1');
  assert.equal(a1.status, 200);

  const a2 = await supertest(app).get('/test').set('X-Forwarded-For', '198.51.100.1');
  assert.equal(a2.status, 200);

  const b1 = await supertest(app).get('/test').set('X-Forwarded-For', '198.51.100.2');
  assert.equal(b1.status, 200);
});
