'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { test } = require('node:test');
const {
  createGracefulShutdown,
  closeHttpServer,
  getShutdownTimeoutMs,
} = require('../src/services/graceful-http-shutdown');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function testLogger() {
  const lines = [];
  return {
    lines,
    info(...args) { lines.push(['info', ...args]); },
    error(...args) { lines.push(['error', ...args]); },
  };
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}

test('a SIGTERM-style drain preserves an active request before closing resources', async t => {
  const entered = deferred();
  const release = deferred();
  const events = [];
  const server = http.createServer(async (_req, res) => {
    events.push('request-start');
    entered.resolve();
    await release.promise;
    res.writeHead(200);
    res.end('delivered');
    events.push('request-end');
  });
  const url = await listen(server);
  t.after(() => { if (server.listening) server.close(); });

  const pendingResponse = fetch(url);
  await entered.promise;

  const logger = testLogger();
  const manager = createGracefulShutdown({
    server,
    stopPoller: () => events.push('poller-stop'),
    closeResources: [
      { name: 'postgres', close: async () => { events.push('db-close'); } },
      { name: 'redis', close: async () => { events.push('redis-close'); } },
    ],
    log: logger,
    timeoutMs: 1500,
  });

  const shutdown = manager.shutdown('SIGTERM');
  assert.equal(server.listening, false, 'listener is closed before in-flight work ends');
  assert.ok(events.includes('poller-stop'));
  assert.ok(!events.includes('db-close'), 'pool must not close before the request finishes');

  release.resolve();
  const response = await pendingResponse;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'delivered');
  await shutdown;
  assert.ok(events.indexOf('db-close') > events.indexOf('request-end'));
  assert.ok(events.indexOf('redis-close') > events.indexOf('request-end'));
  assert.ok(logger.lines.some(line => String(line.at(-1)).includes('All HTTP requests and resources closed')));
});

test('repeated shutdown calls share one drain; resources close exactly once', async t => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await listen(server);
  t.after(() => { if (server.listening) server.close(); });

  let pollerStops = 0;
  let poolCloses = 0;
  const manager = createGracefulShutdown({
    server,
    stopPoller: () => { pollerStops += 1; },
    closeResources: [{ name: 'pool', close: () => { poolCloses += 1; } }],
    log: testLogger(),
    timeoutMs: 500,
  });

  const first = manager.shutdown('SIGTERM');
  assert.equal(first, manager.shutdown('SIGINT'));
  await first;
  assert.equal(pollerStops, 1);
  assert.equal(poolCloses, 1);
});

test('injectable signal handlers exit once and unregister both signals after clean drain', async t => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await listen(server);
  t.after(() => { if (server.listening) server.close(); });

  const emitter = new EventEmitter();
  const exits = deferred();
  const codes = [];
  const manager = createGracefulShutdown({
    server,
    stopPoller: () => {},
    log: testLogger(),
    timeoutMs: 500,
  });

  manager.installSignals({
    emitter,
    exit: code => {
      codes.push(code);
      exits.resolve();
    },
  });

  assert.equal(emitter.listenerCount('SIGTERM'), 1);
  assert.equal(emitter.listenerCount('SIGINT'), 1);
  emitter.emit('SIGTERM');
  await exits.promise;
  assert.deepEqual(codes, [0]);
  assert.equal(emitter.listenerCount('SIGTERM'), 0);
  assert.equal(emitter.listenerCount('SIGINT'), 0);
});

test('a stalled active HTTP request is interrupted only after grace expires', async t => {
  const entered = deferred();
  const release = deferred();
  const server = http.createServer(async (_req, res) => {
    entered.resolve();
    await release.promise;
    if (!res.destroyed) res.end('late');
  });
  const url = await listen(server);
  t.after(() => {
    release.resolve();
    if (server.listening) server.closeAllConnections();
  });
  const inFlight = fetch(url).catch(() => null);
  await entered.promise;

  let poolClosed = false;
  const manager = createGracefulShutdown({
    server,
    stopPoller: () => {},
    closeResources: [{ name: 'postgres', close: () => { poolClosed = true; } }],
    log: testLogger(),
    timeoutMs: 70,
  });

  await assert.rejects(manager.shutdown('SIGTERM'), error => {
    assert.equal(error.name, 'AggregateError');
    assert.ok(error.errors.some(e => /did not drain within/.test(e.message)));
    return true;
  });
  assert.ok(poolClosed, 'resource teardown still runs after a forced HTTP close');
  await inFlight;
});

test('resource failure is reported without skipping other closers', async t => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await listen(server);
  t.after(() => { if (server.listening) server.close(); });

  const events = [];
  const manager = createGracefulShutdown({
    server,
    stopPoller: () => { throw new Error('stop failed'); },
    closeResources: [
      { name: 'redis', close: async () => { throw new Error('redis failed'); } },
      { name: 'postgres', close: async () => { events.push('db-closed'); } },
    ],
    log: testLogger(),
    timeoutMs: 500,
  });
  await assert.rejects(manager.shutdown('SIGINT'), error => {
    assert.equal(error.name, 'AggregateError');
    assert.equal(error.errors.length, 2);
    return true;
  });
  assert.deepEqual(events, ['db-closed']);
});

test('signal handlers return failure exit code when cleanup fails', async t => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await listen(server);
  t.after(() => { if (server.listening) server.close(); });

  const emitter = new EventEmitter();
  const exited = deferred();
  const manager = createGracefulShutdown({
    server,
    closeResources: [{ name: 'postgres', close: async () => { throw new Error('closed badly'); } }],
    log: testLogger(),
    timeoutMs: 500,
  });
  manager.installSignals({ emitter, exit: code => exited.resolve(code) });
  emitter.emit('SIGINT');
  assert.equal(await exited.promise, 1);
});

test('hung resource cleanup is bounded by the total shutdown budget', async t => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await listen(server);
  t.after(() => { if (server.listening) server.close(); });

  let secondCloserStarted = false;
  const manager = createGracefulShutdown({
    server,
    closeResources: [
      { name: 'hung', close: () => new Promise(() => {}) },
      { name: 'other', close: () => { secondCloserStarted = true; } },
    ],
    log: testLogger(),
    timeoutMs: 80,
  });
  await assert.rejects(manager.shutdown('SIGTERM'), error => {
    assert.equal(error.name, 'AggregateError');
    assert.ok(error.errors.some(e => /Resource cleanup did not finish/.test(e.message)));
    return true;
  });
  assert.equal(secondCloserStarted, true);
});

test('timeout config falls back safely and shutdown input is validated', () => {
  assert.equal(getShutdownTimeoutMs(undefined), 30000);
  assert.equal(getShutdownTimeoutMs('60000'), 60000);
  for (const value of ['foo', '-5', '2.5', '9999999999999']) {
    assert.equal(getShutdownTimeoutMs(value), 30000);
  }
  assert.throws(
    () => createGracefulShutdown({ server: null, log: testLogger() }),
    /running HTTP server/
  );
  assert.throws(
    () => createGracefulShutdown({ server: { close() {} }, log: testLogger(), timeoutMs: 0 }),
    /positive integer/
  );
});

test('a synchronous server.close failure still runs cleanup', async () => {
  const server = { close() { throw new Error('fake close error'); } };
  const steps = [];
  const manager = createGracefulShutdown({
    server,
    closeResources: [{ name: 'postgres', close: () => steps.push('pool') }],
    log: testLogger(),
    timeoutMs: 500,
  });
  await assert.rejects(manager.shutdown('SIGTERM'), /Graceful HTTP shutdown was incomplete/);
  assert.deepEqual(steps, ['pool']);
});

test('direct HTTP close reports not-listening errors rather than silently succeeding', async () => {
  const server = http.createServer();
  await assert.rejects(closeHttpServer(server, 100), /Server is not running/);
});
