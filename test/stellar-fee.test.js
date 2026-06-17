const assert = require('node:assert/strict');
const { test } = require('node:test');
const { registerTaskOnChain } = require('../stellar');
const { logger } = require('../src/logger');

test('registerTaskOnChain estimates fee before transaction submission', async () => {
  const calls = [];
  const logs = [];
  const originalInfo = logger.info;

  logger.info = (obj, msg) => {
    const serialized = typeof obj === 'string' ? obj : JSON.stringify(obj) + (msg ? ' ' + msg : '');
    logs.push(serialized);
  };

  try {
    await registerTaskOnChain(42, {
      estimateFee: async () => {
        calls.push('estimateFee');
        return '777';
      },
      submitTransaction: async transaction => {
        calls.push(`submit:${transaction.fee}`);
        return { hash: '0xtest' };
      }
    });
  } finally {
    logger.info = originalInfo;
  }

  assert.deepEqual(calls, ['estimateFee', 'submit:777']);
  assert.ok(logs.some(line => line.includes('"fee":"777"') || line.includes('fee: "777"')));
  assert.ok(!logs.some(line => line.includes('"fee":"100"') || line.includes('fee: "100"')));
});

test('registerTaskOnChain does not submit when fee estimation throws a configuration error', async () => {
  const calls = [];
  const originalInfo = logger.info;
  logger.info = () => {};

  try {
    await assert.rejects(
      () => registerTaskOnChain(42, {
        estimateFee: async () => {
          calls.push('estimateFee');
          throw new Error('invalid fee config');
        },
        submitTransaction: async () => {
          calls.push('submit');
          return { hash: '0xtest' };
        }
      }),
      /invalid fee config/
    );
  } finally {
    logger.info = originalInfo;
  }

  assert.deepEqual(calls, ['estimateFee']);
});
