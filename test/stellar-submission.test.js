const assert = require('node:assert/strict');
const { test } = require('node:test');
const { registerTaskOnChain } = require('../stellar');
const { broadcastTransaction } = require('../src/services/broadcaster');
const { logger } = require('../src/logger');

test('registerTaskOnChain accepts a mocked Stellar submission hash', async () => {
  const calls = [];
  const originalInfo = logger.info;
  logger.info = () => {};

  try {
    const result = await registerTaskOnChain(42, {
      estimateFee: async () => '100',
      submitTransaction: async transaction => {
        calls.push(transaction);
        return { hash: 'tx_hash' };
      }
    });

    assert.deepEqual(result, { hash: 'tx_hash' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      githubId: 42,
      fee: '100',
      feeSource: 'estimated',
      operation: 'manageData',
      key: 'vero:pr:42',
      value: 'registered'
    });
  } finally {
    logger.info = originalInfo;
  }
});

test('registerTaskOnChain surfaces mocked Stellar submission failures safely', async () => {
  const calls = [];
  const originalInfo = logger.info;
  logger.info = () => {};

  try {
    await assert.rejects(
      () => registerTaskOnChain(43, {
        estimateFee: async () => '100',
        submitTransaction: async transaction => {
          calls.push(transaction);
          throw new Error('mock submitTransaction failure');
        }
      }),
      /mock submitTransaction failure/
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, 'vero:pr:43');
  } finally {
    logger.info = originalInfo;
  }
});

test('broadcastTransaction accepts a mocked Stellar server submission hash', async () => {
  const transaction = { id: 'mock-transaction' };
  const submissions = [];
  const server = {
    submitTransaction: async submitted => {
      submissions.push(submitted);
      return { hash: 'tx_hash' };
    }
  };

  const result = await broadcastTransaction(server, transaction);

  assert.deepEqual(result, { hash: 'tx_hash' });
  assert.deepEqual(submissions, [transaction]);
});

test('broadcastTransaction surfaces mocked Stellar server submission errors', async () => {
  const transaction = { id: 'mock-transaction' };
  const submissions = [];
  const server = {
    submitTransaction: async submitted => {
      submissions.push(submitted);
      throw new Error('mock submitTransaction failure');
    }
  };

  await assert.rejects(
    () => broadcastTransaction(server, transaction),
    /mock submitTransaction failure/
  );

  assert.deepEqual(submissions, [transaction]);
});
