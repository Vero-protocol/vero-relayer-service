const assert = require('node:assert/strict');
const { test } = require('node:test');
const request = require('supertest');
const { createApp } = require('../index');

const poolMetrics = {
  totalConnections: 2,
  idleConnections: 2,
  waitingClients: 0,
  maxConnections: 20,
  minConnections: 2,
  totalErrors: 0,
};

function createHealthApp(configSync) {
  return createApp({
    dbHealthCheck: async () => ({ healthy: true, latencyMs: 1 }),
    getPoolMetrics: () => poolMetrics,
    getConfigSyncHealth: () => configSync,
  });
}

test('/health reports OK when database and config sync are healthy', async () => {
  const configSync = {
    healthy: true,
    status: 'running',
    mode: 'worker',
    stale: false,
    staleAfterMs: 15_000,
    lastConfigSyncAt: '2026-08-24T20:30:00.000Z',
    restartAttempts: 0,
    maxRestartAttempts: 3,
  };

  const response = await request(createHealthApp(configSync)).get('/health');

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'OK');
  assert.deepEqual(response.body.configSync, configSync);
  assert.equal(response.body.database.healthy, true);
});

test('/health reports DEGRADED after the config-worker restart budget is exhausted', async () => {
  const configSync = {
    healthy: false,
    status: 'exhausted',
    mode: 'worker',
    stale: false,
    staleAfterMs: 15_000,
    lastConfigSyncAt: null,
    restartAttempts: 3,
    maxRestartAttempts: 3,
  };

  const response = await request(createHealthApp(configSync)).get('/health');

  assert.equal(response.status, 503);
  assert.equal(response.body.status, 'DEGRADED');
  assert.deepEqual(response.body.configSync, configSync);
  assert.equal(response.body.database.healthy, true);
});

test('/health reports DEGRADED when config sync is stale', async () => {
  const configSync = {
    healthy: false,
    status: 'stale',
    mode: 'worker',
    stale: true,
    staleAfterMs: 15_000,
    lastConfigSyncAt: '2026-08-24T20:30:00.000Z',
    restartAttempts: 0,
    maxRestartAttempts: 3,
  };

  const response = await request(createHealthApp(configSync)).get('/health');

  assert.equal(response.status, 503);
  assert.equal(response.body.status, 'DEGRADED');
  assert.deepEqual(response.body.configSync, configSync);
  assert.equal(response.body.database.healthy, true);
});
