const assert = require('node:assert/strict');
const { test } = require('node:test');

// Ensure NODE_ENV is set to test
process.env.NODE_ENV = 'test';

// Stub ioredis connection options so it doesn't try to connect
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '6379';

let mockConfigs = {};
let mockSignature = null;
let mockPayload = null;

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
    async get(key) {
      if (key === 'vero:config:signature') {
        return mockSignature;
      }
      if (key === 'vero:config:payload') {
        return mockPayload;
      }
      return null;
    }
    disconnect() {
      // no-op
    }
  }
};

const { pollConfig, dynamicConfig, verifyConfigSignature, applyConfig } = require('../src/services/config-poller');
const { signJwt } = require('../src/services/jwt');
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

test('config poller applies signed config with valid signature', async () => {
  // Setup JWT signing secret for test
  process.env.JWT_SIGNING_SECRET = 'test-secret-min-32-chars-long';
  process.env.JWT_ISSUER = 'test-issuer';
  
  const testConfig = {
    STELLAR_BASE_FEE: '777',
    STELLAR_MAX_FEE: '6666',
    LOG_LEVEL: 'error'
  };
  
  const payload = JSON.stringify(testConfig);
  const signature = signJwt({ payload });
  
  mockPayload = payload;
  mockSignature = signature;
  mockConfigs = {}; // Clear unsigned config
  
  await pollConfig();
  
  assert.equal(process.env.STELLAR_BASE_FEE, '777');
  assert.equal(process.env.STELLAR_MAX_FEE, '6666');
  assert.equal(logger.level, 'error');
  
  // Cleanup
  mockPayload = null;
  mockSignature = null;
});

test('config poller rejects signed config with invalid signature', async () => {
  process.env.JWT_SIGNING_SECRET = 'test-secret-min-32-chars-long';
  
  const testConfig = {
    STELLAR_BASE_FEE: '555'
  };
  
  mockPayload = JSON.stringify(testConfig);
  mockSignature = 'invalid.signature.token';
  mockConfigs = {
    STELLAR_BASE_FEE: '444' // Fallback unsigned config
  };
  
  // Set initial value
  process.env.STELLAR_BASE_FEE = '333';
  
  await pollConfig();
  
  // Should fall back to unsigned config
  assert.equal(process.env.STELLAR_BASE_FEE, '444');
  
  // Cleanup
  mockPayload = null;
  mockSignature = null;
  mockConfigs = {};
});

test('config poller falls back to unsigned config when signature missing', async () => {
  mockPayload = null;
  mockSignature = null;
  mockConfigs = {
    STELLAR_BASE_FEE: '222',
    LOG_LEVEL: 'debug'
  };
  
  await pollConfig();
  
  assert.equal(process.env.STELLAR_BASE_FEE, '222');
  assert.equal(logger.level, 'debug');
  
  mockConfigs = {};
});

test('applyConfig clears fee engine cache on config change', async () => {
  const { clearFeeEstimateCache } = require('../src/services/fee-engine');
  let cacheCleared = false;
  
  // Mock the clear function
  const originalClear = clearFeeEstimateCache;
  require('../src/services/fee-engine').clearFeeEstimateCache = () => {
    cacheCleared = true;
  };
  
  const testConfig = {
    STELLAR_BASE_FEE: '111'
  };
  
  await applyConfig(testConfig, 'test');
  
  assert.equal(cacheCleared, true);
  assert.equal(process.env.STELLAR_BASE_FEE, '111');
  
  // Restore
  require('../src/services/fee-engine').clearFeeEstimateCache = originalClear;
});
