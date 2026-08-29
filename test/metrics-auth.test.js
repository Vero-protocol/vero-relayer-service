'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const { createApp } = require('../index');
const { registerMetrics, createMetricsRateLimiter } = require('../src/metrics/metrics');
const { signJwt } = require('../src/services/jwt');

const TEST_JWT_SECRET = 'test-metrics-jwt-secret-32-chars-long-0000';

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

function setJwtEnv() {
  process.env.JWT_SIGNING_SECRET = TEST_JWT_SECRET;
  process.env.JWT_ISSUER = 'vero-relayer-service';
}

test('/metrics rejects unauthenticated requests', async t => {
  setJwtEnv();
  t.after(() => {
    delete process.env.JWT_SIGNING_SECRET;
    delete process.env.JWT_ISSUER;
  });

  const app = createApp();
  const server = await listen(app);
  t.after(() => close(server));

  const response = await fetch(url(server, '/metrics'));
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.code, 'MISSING_TOKEN');
});

test('/metrics allows requests with a valid JWT Bearer token', async t => {
  setJwtEnv();
  t.after(() => {
    delete process.env.JWT_SIGNING_SECRET;
    delete process.env.JWT_ISSUER;
  });

  const jwt = signJwt({ sub: 'prometheus', role: 'metrics-scraper' }, { expiresInSeconds: 60 });
  const app = createApp();
  const server = await listen(app);
  t.after(() => close(server));

  const response = await fetch(url(server, '/metrics'), {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/plain/);
  assert.match(body, /# HELP/);
});

test('/metrics applies a scrape rate limit backstop', async t => {
  const app = express();
  registerMetrics(app, {
    authMiddleware: (_req, _res, next) => next(),
    rateLimitMiddleware: createMetricsRateLimiter({ windowMs: 60_000, max: 1 }),
  });

  const server = await listen(app);
  t.after(() => close(server));

  const first = await fetch(url(server, '/metrics'));
  const second = await fetch(url(server, '/metrics'));
  const secondBody = await second.json();

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal(secondBody.code, 'RATE_LIMIT_EXCEEDED');
  assert.equal(second.headers.get('retry-after'), '60');
});
