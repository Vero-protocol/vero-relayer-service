const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const workerThreads = require('node:worker_threads');
const { logger } = require('../src/logger');

const POLLER_PATH = require.resolve('../src/services/config-poller');

function createControlledWorkerClass() {
  return class ControlledWorker extends EventEmitter {
    static instances = [];

    constructor(filename, options) {
      super();
      this.filename = filename;
      this.options = options;
      this.terminated = false;
      this.constructor.instances.push(this);
    }

    terminate() {
      this.terminated = true;
      this.emit('exit', 1);
      return Promise.resolve(1);
    }
  };
}

function loadPoller(t, WorkerClass, { intervalMs = '100' } = {}) {
  const previousEnv = {
    CONFIG_ASYNC_WORKER: process.env.CONFIG_ASYNC_WORKER,
    CONFIG_SYNC_INTERVAL_MS: process.env.CONFIG_SYNC_INTERVAL_MS,
    REDIS_HOST: process.env.REDIS_HOST,
    REDIS_PORT: process.env.REDIS_PORT,
  };

  process.env.CONFIG_ASYNC_WORKER = 'true';
  process.env.CONFIG_SYNC_INTERVAL_MS = intervalMs;
  process.env.REDIS_HOST = '127.0.0.1';
  process.env.REDIS_PORT = '6379';

  t.mock.property(workerThreads, 'Worker', WorkerClass);
  delete require.cache[POLLER_PATH];
  const poller = require(POLLER_PATH);

  t.after(() => {
    poller.stopConfigPoller();
    delete require.cache[POLLER_PATH];

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  return poller;
}

test('a clean config-worker exit is restarted within the first backoff interval', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const WorkerClass = createControlledWorkerClass();
  const poller = loadPoller(t, WorkerClass);

  poller.startConfigPoller();
  assert.equal(WorkerClass.instances.length, 1);

  WorkerClass.instances[0].emit('exit', 0);
  assert.equal(poller.getConfigSyncHealth().status, 'restarting');
  assert.equal(poller.getConfigSyncHealth().restartAttempts, 1);

  // Equal jitter keeps attempt one in the inclusive range 500..999 ms.
  t.mock.timers.tick(1_000);
  assert.equal(WorkerClass.instances.length, 2);
});

test('an error followed by exit clears the handle and schedules only one worker', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const WorkerClass = createControlledWorkerClass();
  const poller = loadPoller(t, WorkerClass);

  poller.startConfigPoller();
  const failedWorker = WorkerClass.instances[0];

  failedWorker.emit('error', new Error('simulated worker crash'));
  failedWorker.emit('exit', 1);
  t.mock.timers.tick(1_000);

  assert.equal(WorkerClass.instances.length, 2);
  assert.equal(poller.getConfigSyncHealth().restartAttempts, 1);
});

test('repeated start calls never create duplicate workers or restart timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const WorkerClass = createControlledWorkerClass();
  const poller = loadPoller(t, WorkerClass);

  poller.startConfigPoller();
  poller.startConfigPoller();
  assert.equal(WorkerClass.instances.length, 1);

  WorkerClass.instances[0].emit('exit', 1);
  poller.startConfigPoller();
  t.mock.timers.tick(1_000);

  assert.equal(WorkerClass.instances.length, 2);
  assert.equal(poller.getConfigSyncHealth().restartAttempts, 1);
});

test('synchronous worker start failures consume the same bounded budget', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });

  class FailingWorker {
    static constructionAttempts = 0;

    constructor() {
      FailingWorker.constructionAttempts += 1;
      throw new Error('simulated constructor failure');
    }
  }

  const poller = loadPoller(t, FailingWorker);
  const errorMock = t.mock.method(logger, 'error', () => {});

  poller.startConfigPoller();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    t.mock.timers.tick(30_000);
  }

  assert.equal(FailingWorker.constructionAttempts, 4);
  assert.equal(poller.getConfigSyncHealth().status, 'exhausted');
  const exhaustedLogs = errorMock.mock.calls.filter(
    call => call.arguments[1] === '[config-poller] Config worker restart budget exhausted'
  );
  assert.equal(exhaustedLogs.length, 1);
});

test('restart exhaustion is bounded, alertable, and reported as unhealthy', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const WorkerClass = createControlledWorkerClass();
  const poller = loadPoller(t, WorkerClass);
  const errorMock = t.mock.method(logger, 'error', () => {});

  poller.startConfigPoller();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    WorkerClass.instances.at(-1).emit('exit', 1);
    assert.equal(poller.getConfigSyncHealth().restartAttempts, attempt);
    t.mock.timers.tick(30_000);
  }

  assert.equal(WorkerClass.instances.length, 4);
  WorkerClass.instances.at(-1).emit('exit', 1);

  const health = poller.getConfigSyncHealth();
  assert.equal(health.healthy, false);
  assert.equal(health.status, 'exhausted');
  assert.equal(health.restartAttempts, 3);

  // A duplicate terminal event cannot exhaust or alert twice.
  WorkerClass.instances.at(-1).emit('exit', 1);
  const exhaustedLogs = errorMock.mock.calls.filter(
    call => call.arguments[1] === '[config-poller] Config worker restart budget exhausted'
  );
  assert.equal(exhaustedLogs.length, 1);
});

test('a successful sync records freshness and replenishes the restart budget', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const WorkerClass = createControlledWorkerClass();
  const poller = loadPoller(t, WorkerClass);

  poller.startConfigPoller();
  WorkerClass.instances[0].emit('exit', 1);
  t.mock.timers.tick(1_000);

  const replacement = WorkerClass.instances[1];
  replacement.emit('message', { type: 'syncSuccess' });

  const healthy = poller.getConfigSyncHealth();
  assert.equal(healthy.status, 'running');
  assert.equal(healthy.restartAttempts, 0);
  assert.equal(healthy.lastConfigSyncAt, '1970-01-01T00:00:02.000Z');

  replacement.emit('exit', 1);
  assert.equal(poller.getConfigSyncHealth().restartAttempts, 1);
});

test('config sync becomes stale after three missed polling intervals', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const WorkerClass = createControlledWorkerClass();
  const poller = loadPoller(t, WorkerClass);

  poller.startConfigPoller();
  WorkerClass.instances[0].emit('message', { type: 'syncSuccess' });

  assert.equal(poller.getConfigSyncHealth(1_300).healthy, true);
  const stale = poller.getConfigSyncHealth(1_301);
  assert.equal(stale.healthy, false);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.stale, true);
});

test('an interval outside the Node timer range falls back consistently', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const WorkerClass = createControlledWorkerClass();
  const poller = loadPoller(t, WorkerClass, { intervalMs: '2147483648' });

  poller.startConfigPoller();

  assert.equal(WorkerClass.instances[0].options.workerData.intervalMs, 5_000);
  assert.equal(poller.getConfigSyncHealth().staleAfterMs, 15_000);
});

test('intentional shutdown cancels pending restarts and never respawns', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const WorkerClass = createControlledWorkerClass();
  const poller = loadPoller(t, WorkerClass);

  poller.startConfigPoller();
  WorkerClass.instances[0].emit('exit', 1);
  assert.equal(poller.getConfigSyncHealth().status, 'restarting');

  poller.stopConfigPoller();
  t.mock.timers.tick(30_000);

  assert.equal(WorkerClass.instances.length, 1);
  assert.equal(poller.getConfigSyncHealth().status, 'stopped');
});
