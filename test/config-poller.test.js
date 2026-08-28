const assert = require('node:assert/strict');
const { test } = require('node:test');

// Ensure NODE_ENV is set to test
process.env.NODE_ENV = 'test';

// Stub ioredis connection options so it doesn't try to connect
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '6379';

// Enable unsigned fallback for tests that exercise it
process.env.CONFIG_SYNC_ALLOW_UNSIGNED = 'true';

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

const { pollConfig, dynamicConfig, verifyConfigSignature, applyConfig, handleWorkerConfigUpdate, CONFIG_ALLOWLIST } = require('../src/services/config-poller');
const { signJwt, CONFIG_AUDIENCE } = require('../src/services/jwt');
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
  process.env.JWT_SIGNING_SECRET = 'test-jwt-secret-32-chars-long-0000000000';
  process.env.JWT_ISSUER = 'test-issuer';
  
  const testConfig = {
    STELLAR_BASE_FEE: '777',
    STELLAR_MAX_FEE: '6666',
    LOG_LEVEL: 'error'
  };
  
  const payload = JSON.stringify(testConfig);
  const signature = signJwt({ payload, aud: CONFIG_AUDIENCE });
  
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
  process.env.JWT_SIGNING_SECRET = 'test-jwt-secret-32-chars-long-0000000000';
  
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

// ============================================================================
// Security regression tests — issue #127
// ============================================================================

// --- Regression 1 -----------------------------------------------------------
// Unsigned config must be rejected in direct-poll mode when the operator has
// NOT opted in via CONFIG_SYNC_ALLOW_UNSIGNED.
test('[security] unsigned config is rejected when CONFIG_SYNC_ALLOW_UNSIGNED is not set', async () => {
  const prev = process.env.CONFIG_SYNC_ALLOW_UNSIGNED;
  process.env.CONFIG_SYNC_ALLOW_UNSIGNED = 'false';

  mockPayload = null;
  mockSignature = null;
  mockConfigs = { STELLAR_BASE_FEE: 'SHOULD_NOT_APPLY' };

  const sentinelValue = 'sentinel-' + Date.now();
  process.env.STELLAR_BASE_FEE = sentinelValue;

  try {
    await pollConfig();
    // The unsigned fallback must have been skipped.
    assert.equal(
      process.env.STELLAR_BASE_FEE,
      sentinelValue,
      'STELLAR_BASE_FEE must not be overwritten when unsigned fallback is disabled'
    );
  } finally {
    process.env.CONFIG_SYNC_ALLOW_UNSIGNED = prev;
    mockConfigs = {};
    delete process.env.STELLAR_BASE_FEE;
  }
});

// --- Regression 2 -----------------------------------------------------------
// config-worker.js async-worker path must NOT label config as source:'signed'
// when the JWT signature is invalid.  handleWorkerConfigUpdate() must also
// reject a message that arrives with source:'signed' but no rawSignature.
test('[security] worker message with source:signed but missing rawSignature is rejected', async () => {
  process.env.JWT_SIGNING_SECRET = 'test-signing-secret-32-chars-min!!';
  process.env.JWT_ISSUER = 'test-issuer';

  const sentinelValue = 'sentinel-' + Date.now();
  process.env.STELLAR_BASE_FEE = sentinelValue;

  // Simulate a worker message that falsely claims source:'signed' but
  // provides no cryptographic material (the old vulnerable behaviour).
  await handleWorkerConfigUpdate({
    type: 'configUpdate',
    configs: { STELLAR_BASE_FEE: 'ATTACKER_VALUE' },
    source: 'signed',
    // rawSignature and rawPayload intentionally omitted
  });

  assert.equal(
    process.env.STELLAR_BASE_FEE,
    sentinelValue,
    'STELLAR_BASE_FEE must not change when worker omits rawSignature'
  );

  delete process.env.STELLAR_BASE_FEE;
});

// --- Regression 2b ----------------------------------------------------------
// handleWorkerConfigUpdate() must reject a signed message whose signature
// does not verify (e.g. wrong key, tampered payload).
test('[security] worker message with source:signed and invalid signature is rejected', async () => {
  process.env.JWT_SIGNING_SECRET = 'test-signing-secret-32-chars-min!!';
  process.env.JWT_ISSUER = 'test-issuer';

  const sentinelValue = 'sentinel-' + Date.now();
  process.env.STELLAR_BASE_FEE = sentinelValue;

  const fakePayload = JSON.stringify({ STELLAR_BASE_FEE: 'ATTACKER_VALUE' });

  await handleWorkerConfigUpdate({
    type: 'configUpdate',
    configs: { STELLAR_BASE_FEE: 'ATTACKER_VALUE' },
    source: 'signed',
    rawSignature: 'bad.jwt.token',
    rawPayload: fakePayload,
  });

  assert.equal(
    process.env.STELLAR_BASE_FEE,
    sentinelValue,
    'STELLAR_BASE_FEE must not change when worker sends invalid signature'
  );

  delete process.env.STELLAR_BASE_FEE;
});

// --- Regression 3 -----------------------------------------------------------
// Sensitive keys must NEVER be applied via dynamic config sync, even when the
// payload carries a valid signature.
test('[security] sensitive keys are blocked by the allowlist even with a valid signature', async () => {
  process.env.JWT_SIGNING_SECRET = 'test-signing-secret-32-chars-min!!';
  process.env.JWT_ISSUER = 'test-issuer';

  const { signJwt } = require('../src/services/jwt');

  // Confirm none of the sensitive keys are on the allowlist
  const sensitiveKeys = [
    'STELLAR_SECRET_KEY',
    'DATABASE_URL',
    'JWT_SIGNING_SECRET',
    'REDIS_PASSWORD',
    'GITHUB_WEBHOOK_SECRET',
    'PGPASSWORD',
    'PGUSER',
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
  ];

  for (const key of sensitiveKeys) {
    assert.equal(
      CONFIG_ALLOWLIST.has(key),
      false,
      `${key} must NOT be on the config sync allowlist`
    );
  }

  // Attempt to apply sensitive keys with a valid signature via direct applyConfig
  const maliciousPayload = {
    STELLAR_SECRET_KEY: 'SATTACKER000000000000000000000000000000000000',
    DATABASE_URL: 'postgresql://attacker:pass@evil.host/db',
    JWT_SIGNING_SECRET: 'attacker-controlled-32-char-secret!!',
    STELLAR_BASE_FEE: '100', // allowed — should be applied
  };

  const origStellarSecret = process.env.STELLAR_SECRET_KEY;
  const origDbUrl = process.env.DATABASE_URL;
  const origJwtSecret = process.env.JWT_SIGNING_SECRET;

  process.env.STELLAR_SECRET_KEY = 'ORIGINAL_SECRET';
  process.env.DATABASE_URL = 'postgresql://legit/db';

  await applyConfig(maliciousPayload, 'signed');

  // Sensitive keys must remain unchanged
  assert.equal(process.env.STELLAR_SECRET_KEY, 'ORIGINAL_SECRET', 'STELLAR_SECRET_KEY must not be overwritten');
  assert.equal(process.env.DATABASE_URL, 'postgresql://legit/db', 'DATABASE_URL must not be overwritten');
  // JWT_SIGNING_SECRET was set to test value above; it must not become the attacker value
  assert.notEqual(process.env.JWT_SIGNING_SECRET, 'attacker-controlled-32-char-secret!!', 'JWT_SIGNING_SECRET must not be overwritten');

  // The allowlisted key should have been applied
  assert.equal(process.env.STELLAR_BASE_FEE, '100', 'allowlisted STELLAR_BASE_FEE should be applied');

  // Restore
  if (origStellarSecret !== undefined) process.env.STELLAR_SECRET_KEY = origStellarSecret;
  else delete process.env.STELLAR_SECRET_KEY;
  if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
  else delete process.env.DATABASE_URL;
  process.env.JWT_SIGNING_SECRET = 'test-signing-secret-32-chars-min!!';
});

// A token minted for ordinary service auth (/metrics, /internal/webhooks/replay)
// used to be equally valid as a config signature — same secret, same issuer, no
// audience claim anywhere. Since CONFIG_ALLOWLIST includes STELLAR_HORIZON_URLS
// and STELLAR_RPC_URLS, and this process holds STELLAR_SECRET_KEY, that let a
// leaked service token plus Redis write access repoint Horizon at an attacker.
test('config poller rejects a signature without the config audience', async () => {
  process.env.JWT_SIGNING_SECRET = 'test-jwt-secret-32-chars-long-0000000000';
  process.env.JWT_ISSUER = 'test-issuer';
  process.env.STELLAR_BASE_FEE = 'untouched';

  const payload = JSON.stringify({ STELLAR_BASE_FEE: '999' });

  // Exactly what a service-auth token looks like: valid signature, valid
  // issuer, no `aud`.
  mockPayload = payload;
  mockSignature = signJwt({ payload });
  mockConfigs = {};

  await pollConfig();

  assert.equal(
    process.env.STELLAR_BASE_FEE,
    'untouched',
    'config must not be applied from a token lacking the config audience'
  );

  mockPayload = null;
  mockSignature = null;
  delete process.env.STELLAR_BASE_FEE;
});

test('config poller rejects a signature carrying a different audience', async () => {
  process.env.JWT_SIGNING_SECRET = 'test-jwt-secret-32-chars-long-0000000000';
  process.env.JWT_ISSUER = 'test-issuer';
  process.env.STELLAR_BASE_FEE = 'untouched';

  const payload = JSON.stringify({ STELLAR_BASE_FEE: '999' });
  mockPayload = payload;
  mockSignature = signJwt({ payload, aud: 'vero-service-auth' });
  mockConfigs = {};

  await pollConfig();

  assert.equal(process.env.STELLAR_BASE_FEE, 'untouched');

  mockPayload = null;
  mockSignature = null;
  delete process.env.STELLAR_BASE_FEE;
});

// ============================================================================
// RPC factory cache invalidation — issue #221
// ============================================================================

// When applyConfig writes any of the three network/endpoint keys
// (STELLAR_NETWORK, STELLAR_HORIZON_URLS, STELLAR_RPC_URLS), it must call
// rpcFactory.invalidateCache() so the very next getHorizonServer() or
// getSorobanServer() call picks up the new values instead of stale ones.

test('[rpc-factory integration] applyConfig calls rpcFactory.invalidateCache() when STELLAR_NETWORK changes', async () => {
  // Intercept the rpc-factory module's invalidateCache method to spy on it.
  // We require it here so we get the same singleton that config-poller.js uses
  // (Node's module cache guarantees only one instance).
  const rpcFactory = require('../src/services/rpc-factory');

  let invalidated = false;
  const origInvalidate = rpcFactory.invalidateCache.bind(rpcFactory);
  rpcFactory.invalidateCache = () => {
    invalidated = true;
    origInvalidate();
  };

  try {
    await applyConfig({ STELLAR_NETWORK: 'mainnet' }, 'test');
    assert.equal(invalidated, true, 'invalidateCache() must be called when STELLAR_NETWORK changes');
  } finally {
    rpcFactory.invalidateCache = origInvalidate;
    delete process.env.STELLAR_NETWORK;
  }
});

test('[rpc-factory integration] applyConfig calls rpcFactory.invalidateCache() when STELLAR_HORIZON_URLS changes', async () => {
  const rpcFactory = require('../src/services/rpc-factory');

  let invalidated = false;
  const origInvalidate = rpcFactory.invalidateCache.bind(rpcFactory);
  rpcFactory.invalidateCache = () => {
    invalidated = true;
    origInvalidate();
  };

  try {
    await applyConfig({ STELLAR_HORIZON_URLS: 'https://horizon-new.example.com' }, 'test');
    assert.equal(invalidated, true, 'invalidateCache() must be called when STELLAR_HORIZON_URLS changes');
  } finally {
    rpcFactory.invalidateCache = origInvalidate;
    delete process.env.STELLAR_HORIZON_URLS;
  }
});

test('[rpc-factory integration] applyConfig calls rpcFactory.invalidateCache() when STELLAR_RPC_URLS changes', async () => {
  const rpcFactory = require('../src/services/rpc-factory');

  let invalidated = false;
  const origInvalidate = rpcFactory.invalidateCache.bind(rpcFactory);
  rpcFactory.invalidateCache = () => {
    invalidated = true;
    origInvalidate();
  };

  try {
    await applyConfig({ STELLAR_RPC_URLS: 'https://rpc-new.example.com' }, 'test');
    assert.equal(invalidated, true, 'invalidateCache() must be called when STELLAR_RPC_URLS changes');
  } finally {
    rpcFactory.invalidateCache = origInvalidate;
    delete process.env.STELLAR_RPC_URLS;
  }
});

test('[rpc-factory integration] applyConfig does NOT call rpcFactory.invalidateCache() for non-endpoint keys', async () => {
  const rpcFactory = require('../src/services/rpc-factory');

  let invalidated = false;
  const origInvalidate = rpcFactory.invalidateCache.bind(rpcFactory);
  rpcFactory.invalidateCache = () => {
    invalidated = true;
    origInvalidate();
  };

  try {
    // Only allowlisted non-endpoint keys — must NOT trigger invalidation
    await applyConfig({ STELLAR_BASE_FEE: '200', LOG_LEVEL: 'info' }, 'test');
    assert.equal(invalidated, false, 'invalidateCache() must NOT be called for non-endpoint keys');
  } finally {
    rpcFactory.invalidateCache = origInvalidate;
  }
});
