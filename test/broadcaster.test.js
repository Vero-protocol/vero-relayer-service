const assert = require('node:assert/strict');
const { test } = require('node:test');
const { broadcastTransaction, fetchAccount } = require('../src/services/broadcaster');

test('broadcastTransaction converts timeout submission failures to a 503 service error', async () => {
  let calls = 0;
  const timeout = new Error('Horizon submitTransaction timed out');
  timeout.code = 'ETIMEDOUT';

  await assert.rejects(
    () => broadcastTransaction({
      submitTransaction: async () => {
        calls += 1;
        throw timeout;
      }
    }, {}, { maxRetries: 0, baseDelay: 0 }),
    error => {
      assert.equal(error.code, 'STELLAR_SERVICE_UNAVAILABLE');
      assert.equal(error.statusCode, 503);
      assert.equal(error.operation, 'submitTransaction');
      assert.equal(error.cause, timeout);
      return true;
    }
  );

  assert.equal(calls, 1);
});

test('fetchAccount converts Horizon network failures to a 503 service error', async () => {
  const networkError = new Error('fetch failed');
  networkError.code = 'ECONNRESET';

  await assert.rejects(
    () => fetchAccount({
      loadAccount: async () => {
        throw networkError;
      }
    }, 'GACCOUNT', { maxRetries: 0, baseDelay: 0 }),
    error => {
      assert.equal(error.code, 'STELLAR_SERVICE_UNAVAILABLE');
      assert.equal(error.statusCode, 503);
      assert.equal(error.operation, 'loadAccount');
      assert.equal(error.cause, networkError);
      return true;
    }
  );
});

test('broadcastTransaction keeps non-network submission contract errors unchanged', async () => {
  await assert.rejects(
    () => broadcastTransaction({
      submitTransaction: async () => ({})
    }, {}, { maxRetries: 0, baseDelay: 0 }),
    /returned no hash/
  );
});
