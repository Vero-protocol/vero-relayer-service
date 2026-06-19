const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const express = require('express');
const { closeHttpServer, startServer } = require('../index');

function makeLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('server shutdown drains active HTTP work before closing shared resources', async t => {
  const events = [];
  let requestStarted;
  let finishRequest;

  const app = express();
  const requestStartedPromise = new Promise(resolve => {
    requestStarted = resolve;
  });
  const finishRequestPromise = new Promise(resolve => {
    finishRequest = resolve;
  });

  app.get('/slow', async (req, res) => {
    events.push('request-start');
    requestStarted();
    await finishRequestPromise;
    events.push('request-finish');
    res.status(200).send('done');
  });

  const server = await startServer({
    app,
    port: 0,
    handleSignals: false,
    logger: makeLogger(),
    validateRedisConfig: () => events.push('validate-queue-config'),
    startConfigPoller: () => events.push('poller-start'),
    stopConfigPoller: () => events.push('poller-stop'),
    closeEventQueue: async () => events.push('queue-close'),
    closeDbPool: async () => events.push('db-close')
  });

  t.after(async () => {
    if (server.listening) {
      await closeHttpServer(server);
    }
  });

  if (!server.listening) {
    await once(server, 'listening');
  }

  const responsePromise = fetch(`http://127.0.0.1:${server.address().port}/slow`);
  await requestStartedPromise;

  const shutdownPromise = server.shutdown('SIGTERM');
  await wait(25);

  assert.equal(events.includes('queue-close'), false);
  assert.equal(events.includes('db-close'), false);

  finishRequest();
  const response = await responsePromise;
  assert.equal(await response.text(), 'done');

  await shutdownPromise;

  assert.ok(events.indexOf('request-finish') < events.indexOf('queue-close'));
  assert.ok(events.indexOf('request-finish') < events.indexOf('db-close'));
  assert.deepEqual(events, [
    'validate-queue-config',
    'poller-start',
    'request-start',
    'poller-stop',
    'request-finish',
    'queue-close',
    'db-close'
  ]);
});
