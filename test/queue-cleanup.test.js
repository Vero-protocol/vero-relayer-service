const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const { cleanFailedJobs, createCleanupJob, SEVEN_DAYS_MS, CLEANUP_BATCH_LIMIT } = require('../src/queue/cleanup');

function makeQueue(removedIds = ['job-1', 'job-2']) {
  return {
    name: 'test-queue',
    clean: async (grace, limit, type) => removedIds
  };
}

function makeLogger() {
  const calls = [];
  return {
    _calls: calls,
    info: (data, msg) => calls.push({ level: 'info', data, msg }),
    error: (data, msg) => calls.push({ level: 'error', data, msg })
  };
}

test('cleanFailedJobs removes failed jobs older than 7 days', async () => {
  const queue = makeQueue(['job-1', 'job-2', 'job-3']);
  const logger = makeLogger();

  const removed = await cleanFailedJobs(queue, { logger });

  assert.deepEqual(removed, ['job-1', 'job-2', 'job-3']);
  assert.equal(logger._calls.filter(c => c.level === 'info').length, 2);
  assert.match(logger._calls[0].msg, /started/);
  assert.match(logger._calls[1].msg, /completed/);
  assert.equal(logger._calls[1].data.removed, 3);
});

test('cleanFailedJobs passes correct grace period and limit to queue.clean', async () => {
  const calls = [];
  const queue = {
    name: 'test-queue',
    clean: async (grace, limit, type) => {
      calls.push({ grace, limit, type });
      return [];
    }
  };

  await cleanFailedJobs(queue, { logger: makeLogger() });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].grace, SEVEN_DAYS_MS);
  assert.equal(calls[0].limit, CLEANUP_BATCH_LIMIT);
  assert.equal(calls[0].type, 'failed');
});

test('cleanFailedJobs accepts custom grace and limit overrides', async () => {
  const calls = [];
  const queue = {
    name: 'test-queue',
    clean: async (grace, limit, type) => {
      calls.push({ grace, limit, type });
      return [];
    }
  };

  await cleanFailedJobs(queue, { logger: makeLogger(), grace: 1000, limit: 50 });

  assert.equal(calls[0].grace, 1000);
  assert.equal(calls[0].limit, 50);
});

test('cleanFailedJobs logs an error when queue.clean throws', async () => {
  const queue = {
    name: 'test-queue',
    clean: async () => { throw new Error('Redis unavailable'); }
  };
  const logger = makeLogger();

  await assert.rejects(
    () => cleanFailedJobs(queue, { logger }),
    /Redis unavailable/
  );
});

test('createCleanupJob returns a task with start/stop methods', () => {
  const queue = makeQueue();
  const task = createCleanupJob(queue, { logger: makeLogger() });

  assert.equal(typeof task.start, 'function');
  assert.equal(typeof task.stop, 'function');

  task.stop();
});

test('createCleanupJob rejects invalid cron expressions', () => {
  assert.throws(
    () => createCleanupJob(makeQueue(), { logger: makeLogger(), schedule: 'not-a-cron' }),
    /Invalid cron expression/
  );
});

test('createCleanupJob logs error without throwing when cleanup fails mid-run', async () => {
  const failingQueue = {
    name: 'fail-queue',
    clean: async () => { throw new Error('timeout'); }
  };
  const logger = makeLogger();

  const task = createCleanupJob(failingQueue, { logger, schedule: '* * * * * *' });
  task.start();

  await new Promise(resolve => setTimeout(resolve, 1100));
  task.stop();

  const errorLogs = logger._calls.filter(c => c.level === 'error');
  assert.ok(errorLogs.length >= 1, 'expected at least one error log');
  assert.match(errorLogs[0].data.error, /timeout/);
});
