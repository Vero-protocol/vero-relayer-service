const assert = require('node:assert/strict');
const { test } = require('node:test');
const { verifySignature } = require('../src/middleware/auth');

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function withoutWebhookEnv(fn) {
  const previous = {
    secret: process.env.GITHUB_WEBHOOK_SECRET,
    allowUnsigned: process.env.ALLOW_UNSIGNED_WEBHOOKS,
    nodeEnv: process.env.NODE_ENV
  };

  delete process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.ALLOW_UNSIGNED_WEBHOOKS;

  try {
    fn();
  } finally {
    for (const [name, value] of [
      ['GITHUB_WEBHOOK_SECRET', previous.secret],
      ['ALLOW_UNSIGNED_WEBHOOKS', previous.allowUnsigned],
      ['NODE_ENV', previous.nodeEnv]
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('missing webhook secret is rejected outside production without explicit opt-in', () => {
  withoutWebhookEnv(() => {
    process.env.NODE_ENV = 'staging';
    const res = response();
    let nextCalled = false;

    verifySignature({ headers: {} }, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Webhook secret is not configured' });
  });
});

test('unsigned webhook is accepted and loudly warned about only with explicit opt-in', () => {
  withoutWebhookEnv(() => {
    process.env.NODE_ENV = 'staging';
    process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';
    const warnings = [];
    const req = {
      headers: {},
      log: { warn: message => warnings.push(message) }
    };
    const res = response();
    let nextCalled = false;

    verifySignature(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /SECURITY WARNING.*ALLOW_UNSIGNED_WEBHOOKS=true/);
  });
});

test('unsigned webhook opt-in is strict and does not accept other truthy values', () => {
  withoutWebhookEnv(() => {
    process.env.ALLOW_UNSIGNED_WEBHOOKS = '1';
    const res = response();
    let nextCalled = false;

    verifySignature({ headers: {} }, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 500);
  });
});
