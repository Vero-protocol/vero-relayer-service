const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const { createApp, startServer } = require('../index');
const { startEventWorker } = require('../src/workers/event-worker');

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve(server));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('/health returns 503 while migration state is unknown or incomplete', async t => {
  let databaseChecked = false;
  const app = createApp({
    dbHealthCheck: async () => {
      databaseChecked = true;
      return { healthy: true, latencyMs: 1 };
    },
  });
  const server = await listen(app);
  t.after(() => close(server));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.status, 'DEGRADED');
  assert.equal(body.database.migrationsComplete, false);
  assert.equal(databaseChecked, false);
});

test('/health returns 200 only after migrations complete and the database is healthy', async t => {
  const app = createApp({
    migrationsComplete: true,
    dbHealthCheck: async () => ({ healthy: true, latencyMs: 1 }),
    getPoolMetrics: () => ({ total: 1 }),
  });
  const server = await listen(app);
  t.after(() => close(server));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.database.migrationsComplete, true);
});

test('startServer rejects migration failure before binding a port', async () => {
  let appCreated = false;

  await assert.rejects(
    startServer({
      runMigrations: async () => { throw new Error('database unreachable'); },
      createApp: () => {
        appCreated = true;
        return express();
      },
    }),
    /database unreachable/
  );

  assert.equal(appCreated, false);
});

test('startEventWorker rejects migration failure before creating a consumer', async () => {
  let workerCreated = false;

  await assert.rejects(
    startEventWorker({
      runMigrations: async () => { throw new Error('retry_state unavailable'); },
      createEventWorker: () => {
        workerCreated = true;
        return {};
      },
    }),
    /retry_state unavailable/
  );

  assert.equal(workerCreated, false);
});
