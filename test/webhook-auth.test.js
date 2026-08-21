const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  classifySignature,
  isSignatureVerified,
  verifySignature,
} = require('../src/middleware/auth');

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
    assert.equal(isSignatureVerified(req), false);
    assert.equal(res.statusCode, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /SECURITY WARNING.*ALLOW_UNSIGNED_WEBHOOKS=true/);
  });
});

test('classifier verifies GitHub official HMAC-SHA256 test vector', () => {
  withoutWebhookEnv(() => {
    process.env.GITHUB_WEBHOOK_SECRET = "It's a Secret to Everybody";
    const req = {
      headers: {
        'x-hub-signature-256': 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'
      },
      rawBody: Buffer.from('Hello, World!', 'utf8')
    };
    classifySignature(req);

    assert.equal(isSignatureVerified(req), true);
  });
});

test('signature enforcement reuses the classifier decision', () => {
  withoutWebhookEnv(() => {
    process.env.GITHUB_WEBHOOK_SECRET = "It's a Secret to Everybody";
    let signatureReads = 0;
    const headers = {};
    Object.defineProperty(headers, 'x-hub-signature-256', {
      get() {
        signatureReads += 1;
        return 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
      }
    });
    const req = {
      headers,
      rawBody: Buffer.from('Hello, World!', 'utf8')
    };
    const res = response();
    let nextCalled = false;

    classifySignature(req);
    verifySignature(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(signatureReads, 1);
  });
});

test('classifier treats malformed and wrong-length signatures as unverified', () => {
  withoutWebhookEnv(() => {
    process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';

    for (const signature of ['garbage', 'sha256=', 'sha256=not-hex']) {
      const req = {
        headers: { 'x-hub-signature-256': signature },
        rawBody: Buffer.from('{}', 'utf8')
      };

      assert.doesNotThrow(() => classifySignature(req));
      assert.equal(isSignatureVerified(req), false);
    }
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
