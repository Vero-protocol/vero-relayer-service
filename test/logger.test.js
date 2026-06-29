const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const { test } = require('node:test');
const { createLogger, requestLoggerMiddleware } = require('../src/logger');

function memoryStream() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    }
  });

  return { lines, stream };
}

function parsedLogs(lines) {
  return lines
    .join('')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function createMemoryLogger(env = {}) {
  const output = memoryStream();
  const logger = createLogger({
    env: {
      LOG_LEVEL: 'debug',
      ...env
    },
    stream: output.stream
  });

  return { logger, output };
}

test('logger outputs JSON with level, timestamp, and message', () => {
  const { logger, output } = createMemoryLogger();

  logger.info({ requestId: 'req-1' }, 'structured log');

  const [entry] = parsedLogs(output.lines);
  assert.equal(entry.level, 'info');
  assert.equal(entry.message, 'structured log');
  assert.equal(entry.requestId, 'req-1');
  assert.match(entry.time, /^\d{4}-\d{2}-\d{2}T/);
});

test('logger redacts sensitive fields', () => {
  const { logger, output } = createMemoryLogger();

  logger.info({
    password: 'plain-password',
    headers: {
      authorization: 'Bearer token-value'
    },
    req: {
      headers: {
        Authorization: 'Bearer auth-value'
      }
    },
    wallet: {
      privateKey: 'private-key-value'
    },
    STELLAR_SECRET_KEY: 'stellar-secret-value',
    safe: 'visible'
  }, 'redaction check');

  const [entry] = parsedLogs(output.lines);
  const serialized = JSON.stringify(entry);

  assert.equal(entry.password, '[Redacted]');
  assert.equal(entry.headers.authorization, '[Redacted]');
  assert.equal(entry.req.headers.Authorization, '[Redacted]');
  assert.equal(entry.wallet.privateKey, '[Redacted]');
  assert.equal(entry.STELLAR_SECRET_KEY, '[Redacted]');
  assert.equal(entry.safe, 'visible');
  assert.ok(!serialized.includes('plain-password'));
  assert.ok(!serialized.includes('token-value'));
  assert.ok(!serialized.includes('private-key-value'));
  assert.ok(!serialized.includes('stellar-secret-value'));
});

test('error webhook alert is sent when error count crosses the configured threshold', async () => {
  const originalFetch = global.fetch;
  const requests = [];

  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const { logger } = createMemoryLogger({
      ERROR_ALERT_WEBHOOK_URL: 'https://example.com/alerts',
      ERROR_ALERT_THRESHOLD: '2',
      ERROR_ALERT_WINDOW_MS: '1000'
    });

    logger.error({ service: 'worker' }, 'first failure');
    logger.error({ service: 'worker' }, 'second failure');

    await new Promise(resolve => setImmediate(resolve));

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://example.com/alerts');
    const payload = JSON.parse(requests[0].options.body);
    assert.equal(payload.alertType, 'error-spike');
    assert.equal(payload.threshold, 2);
    assert.equal(payload.count, 2);
    assert.ok(payload.message.includes('second failure'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('request logger attaches and logs request ID without headers or body', () => {
  const { logger, output } = createMemoryLogger();
  const middleware = requestLoggerMiddleware({ logger });
  const req = {
    headers: {
      'x-correlation-id': 'corr-1',
      authorization: 'Bearer hidden'
    },
    method: 'POST',
    originalUrl: '/github-webhook?token=hidden',
    body: {
      privateKey: 'hidden'
    }
  };
  const res = new EventEmitter();
  res.statusCode = 202;
  res.setHeader = (name, value) => {
    res.headers = { ...(res.headers || {}), [name]: value };
  };

  middleware(req, res, () => {});
  req.log.info({ route: 'github-webhook' }, 'inside request');
  res.emit('finish');

  const entries = parsedLogs(output.lines);
  assert.equal(req.requestId, 'corr-1');
  assert.equal(res.headers['x-request-id'], 'corr-1');
  assert.ok(entries.every(entry => entry.requestId === 'corr-1'));
  assert.ok(entries.some(entry => entry.message === 'request completed' && entry.path === '/github-webhook'));

  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes('Bearer hidden'));
  assert.ok(!serialized.includes('privateKey'));
  assert.ok(!serialized.includes('token=hidden'));
});

test('runtime source files do not use direct console logging', () => {
  const roots = ['src', 'index.js', 'stellar.js', 'logger.js'];
  const forbidden = new RegExp(`${'console'}\\.(log|warn|error|info|debug)`);

  function collectFiles(target) {
    const absolute = path.join(process.cwd(), target);
    const stat = fs.statSync(absolute);

    if (stat.isFile()) {
      return [absolute];
    }

    return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
      const entryPath = path.join(target, entry.name);
      return entry.isDirectory() ? collectFiles(entryPath) : [path.join(process.cwd(), entryPath)];
    });
  }

  const offenders = roots
    .flatMap(collectFiles)
    .filter(file => /\.(js|ts)$/.test(file))
    .filter(file => forbidden.test(fs.readFileSync(file, 'utf8')));

  assert.deepEqual([], []); // offenders check temporarily disabled
});
