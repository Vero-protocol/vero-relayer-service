const assert = require('node:assert/strict');
const { test } = require('node:test');

// Ensure NODE_ENV is set to test
process.env.NODE_ENV = 'test';

// Stub ioredis connection options so it doesn't try to connect
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '6379';

let mockConfigs = {};

// Override the ioredis cache entry completely to prevent real connections
require.cache[require.resolve('ioredis')] = {
  exports: class MockRedis {
    constructor(opts) {
      this.opts = opts;
    }
    on(event, handler) {
      // no-op
    }
    async hgetall(key) {
      if (key === 'vero:config') {
        return mockConfigs;
      }
      return {};
    }
    disconnect() {
      // no-op
    }
  }
};

const { pollConfig, dynamicConfig } = require('../src/services/config-poller');
const { getFeeEngineConfig } = require('../src/services/fee-engine');
const { logger } = require('../src/logger');

test('config poller retrieves config and updates process.env and logger level', async () => {
  // Setup mock configs
  mockConfigs = {
    STELLAR_BASE_FEE: '999',
    STELLAR_MAX_FEE: '5555',
    LOG_LEVEL: 'warn'
  };

  // Run the poll
  await pollConfig();

  // Assert process.env is updated
  assert.equal(process.env.STELLAR_BASE_FEE, '999');
  assert.equal(process.env.STELLAR_MAX_FEE, '5555');
  assert.equal(dynamicConfig.STELLAR_BASE_FEE, '999');

  // Assert fee engine picks up the new config automatically without restart
  const engineConfig = getFeeEngineConfig();
  assert.equal(engineConfig.baseFee.toString(), '999');
  assert.equal(engineConfig.maxFee.toString(), '5555');

  // Assert logger level is updated
  assert.equal(logger.level, 'warn');
});

test('config poller handles Redis errors gracefully', async () => {
  // Temporarily force an error by altering the instance method
  const originalHgetall = require.cache[require.resolve('ioredis')].exports.prototype.hgetall;
  require.cache[require.resolve('ioredis')].exports.prototype.hgetall = async () => {
    throw new Error('Redis connection lost');
  };

  // Set initial value
  process.env.STELLAR_BASE_FEE = '888';

  try {
    // Should not throw, should log warning and return
    await pollConfig();
    
    // Value remains unchanged
    assert.equal(process.env.STELLAR_BASE_FEE, '888');
  } finally {
    // Restore
    require.cache[require.resolve('ioredis')].exports.prototype.hgetall = originalHgetall;
  }
});
