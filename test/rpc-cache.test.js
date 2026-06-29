'use strict';

const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const {
  CACHE_KEY_PREFIX,
  DEFAULT_TTL,
  createRpcCache,
  buildCacheKey,
  hashArgs
} = require('../src/services/rpc-cache');

// ---------------------------------------------------------------------------
// Valid Stellar-formatted keys for sensitive data tests
// Stellar keys are 56 chars: prefix (S or G) + 55 base32 (A-Z,2-7)
// ---------------------------------------------------------------------------
const VALID_STELLAR_SEED = 'S' + 'A2Z7ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS';
const VALID_STELLAR_ACCOUNT = 'G' + 'A2Z7ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS';

// ---------------------------------------------------------------------------
// Unit tests — pure functions that don't need a Redis mock
// ---------------------------------------------------------------------------

test('buildCacheKey includes the network, keyPrefix, and argHash', () => {
  const key = buildCacheKey('testnet', 'fee-stats', 'abc123');
  assert.equal(key, 'rpc-cache:testnet:fee-stats:abc123');
});

test('buildCacheKey supports mainnet isolation', () => {
  const testnet = buildCacheKey('testnet', 'account', 'deadbeef');
  const mainnet = buildCacheKey('mainnet', 'account', 'deadbeef');
  assert.notEqual(testnet, mainnet);
  assert.ok(testnet.includes('testnet'));
  assert.ok(mainnet.includes('mainnet'));
});

test('hashArgs produces stable output for the same input', () => {
  const a = hashArgs({ a: 1, b: 'hello' });
  const b = hashArgs({ a: 1, b: 'hello' });
  assert.equal(a, b);
});

test('hashArgs produces different output for different input', () => {
  const a = hashArgs('account1');
  const b = hashArgs('account2');
  assert.notEqual(a, b);
});

test('hashArgs handles BigInt values', () => {
  const a = hashArgs(100n);
  const b = hashArgs(100n);
  assert.equal(a, b);
});

test('hashArgs produces consistent hash for args regardless of property order', () => {
  const a = hashArgs({ x: 1, y: 2 });
  const b = hashArgs({ y: 2, x: 1 });
  assert.equal(a, b);
});

test('hashArgs handles multiple arguments', () => {
  const result = hashArgs('account', 'GA12345');
  assert.equal(typeof result, 'string');
  assert.equal(result.length, 16); // sha256 hex truncated to 16 chars
});

test('DEFAULT_TTL has expected values', () => {
  assert.equal(DEFAULT_TTL.account, 10_000);
  assert.equal(DEFAULT_TTL['fee-stats'], 60_000);
});

// ---------------------------------------------------------------------------
// RpcCacheInstance — wrap with a fake Redis
// ---------------------------------------------------------------------------

/**
 * Build a fake Redis client that stores data in a Map.
 */
function fakeRedis() {
  const store = new Map();

  return {
    _store: store,
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
    },
    del: async (...keys) => {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count++;
      }
      return count;
    },
    scan: async (cursor, matchToken, pattern, countToken, count) => {
      const regex = new RegExp('^' + pattern.replace(/[*]/g, '.*') + '$');
      const matchingKeys = Array.from(store.keys()).filter(k => regex.test(k));
      return ['0', matchingKeys];
    },
    quit: async () => {},
    on: () => {}
  };
}

test('wrap returns a function', () => {
  const cache = createRpcCache({ redis: fakeRedis() });
  const wrapped = cache.wrap(async (x) => x, { keyPrefix: 'test' });
  assert.equal(typeof wrapped, 'function');
});

test('wrap throws when keyPrefix is missing', () => {
  const cache = createRpcCache({ redis: fakeRedis() });
  assert.throws(
    () => cache.wrap(async (x) => x, {}),
    /keyPrefix is required/
  );
});

test('cache returns the same value on repeated calls without invoking the underlying function', async () => {
  const cache = createRpcCache({ redis: fakeRedis() });
  let callCount = 0;

  const wrapped = cache.wrap(
    async (x) => {
      callCount += 1;
      return { value: x };
    },
    { keyPrefix: 'test', ttlMs: 60_000 }
  );

  const first = await wrapped(42);
  assert.deepEqual(first, { value: 42 });
  assert.equal(callCount, 1);

  const second = await wrapped(42);
  assert.deepEqual(second, { value: 42 });
  assert.equal(callCount, 1, 'should not invoke fn on cache hit');

  assert.equal(cache.getStats().hits, 1);
  assert.equal(cache.getStats().misses, 1);
});

test('cache differentiates between different arguments', async () => {
  const cache = createRpcCache({ redis: fakeRedis() });
  let callCount = 0;

  const wrapped = cache.wrap(
    async (x) => {
      callCount += 1;
      return { value: x };
    },
    { keyPrefix: 'test', ttlMs: 60_000 }
  );

  await wrapped('a');
  await wrapped('b');
  await wrapped('a');

  assert.equal(callCount, 2);
  assert.equal(cache.getStats().hits, 1);
  assert.equal(cache.getStats().misses, 2);
});

test('cache key is scoped by network (testnet vs mainnet)', async () => {
  const redis = fakeRedis();
  const cache = createRpcCache({ redis });
  const callLog = [];

  const wrapped = cache.wrap(
    async (x) => {
      callLog.push(x);
      return { value: x };
    },
    {
      keyPrefix: 'test',
      ttlMs: 60_000,
      networkFn: () => process.env.STELLAR_NETWORK || 'testnet'
    }
  );

  process.env.STELLAR_NETWORK = 'testnet';
  await wrapped('data');
  process.env.STELLAR_NETWORK = 'mainnet';
  await wrapped('data');

  assert.equal(callLog.length, 2);
  assert.equal(cache.getStats().hits, 0);
  assert.equal(cache.getStats().misses, 2);
});

test('cache recovers from Redis read errors and falls through to live RPC', async () => {
  let calls = 0;
  const redis = fakeRedis();
  redis.get = async () => { throw new Error('connection lost'); };

  const cache = createRpcCache({ redis });
  const wrapped = cache.wrap(
    async (x) => {
      calls += 1;
      return x;
    },
    { keyPrefix: 'test', ttlMs: 60_000 }
  );

  const result = await wrapped(99);
  assert.equal(result, 99);
  assert.equal(calls, 1);
  assert.equal(cache.getStats().errors, 1);
});

test('cache recovers from Redis write errors and returns the live result', async () => {
  let calls = 0;
  const redis = fakeRedis();
  redis.set = async () => { throw new Error('write failed'); };

  const cache = createRpcCache({ redis });
  const wrapped = cache.wrap(
    async (x) => {
      calls += 1;
      return x;
    },
    { keyPrefix: 'test', ttlMs: 60_000 }
  );

  const result = await wrapped(55);
  assert.equal(result, 55);

  // Second call is also a miss (cache write failed on first call), and write fails again
  const result2 = await wrapped(55);
  assert.equal(result2, 55);

  // Both calls failed on set() — 2 errors
  assert.equal(cache.getStats().errors, 2);
  // Both calls were cache misses — 2 misses
  assert.equal(cache.getStats().misses, 2);
});

test('clearCache removes all keys with the rpc-cache prefix', async () => {
  const redis = fakeRedis();
  const cache = createRpcCache({ redis });

  const wrapped = cache.wrap(async (x) => x, { keyPrefix: 'test', ttlMs: 60_000 });
  await wrapped('a');
  await wrapped('b');
  await wrapped('c');

  assert.equal(redis._store.size, 3);

  const deleted = await cache.clearCache();
  assert.equal(deleted, 3);
  assert.equal(redis._store.size, 0);
});

test('getStats returns a snapshot of hit/miss/error counters', async () => {
  const cache = createRpcCache({ redis: fakeRedis() });
  const wrapped = cache.wrap(async (x) => x, { keyPrefix: 'stats-test', ttlMs: 60_000 });

  assert.deepEqual(cache.getStats(), { hits: 0, misses: 0, errors: 0 });

  await wrapped('first'); // miss
  await wrapped('first'); // hit
  await wrapped('second'); // miss

  const s = cache.getStats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 2);
  assert.equal(s.errors, 0);
});

// ---------------------------------------------------------------------------
// Noop cache — when Redis is not configured
// ---------------------------------------------------------------------------

test('createRpcCache returns a noop cache when no redis provided and no env vars set', () => {
  const origHost = process.env.REDIS_HOST;
  const origPort = process.env.REDIS_PORT;
  delete process.env.REDIS_HOST;
  delete process.env.REDIS_PORT;

  try {
    const cache = createRpcCache();
    assert.ok(cache.wrap);
    assert.ok(cache.close);
    assert.ok(cache.clearCache);
    assert.ok(cache.getStats);
    assert.deepEqual(cache.getStats(), { hits: 0, misses: 0, errors: 0 });
  } finally {
    if (origHost) process.env.REDIS_HOST = origHost;
    if (origPort) process.env.REDIS_PORT = origPort;
  }
});

test('noop cache returns the original function unwrapped', async () => {
  const origHost = process.env.REDIS_HOST;
  const origPort = process.env.REDIS_PORT;
  delete process.env.REDIS_HOST;
  delete process.env.REDIS_PORT;

  try {
    const cache = createRpcCache();
    let callCount = 0;
    const fn = async (x) => { callCount += 1; return x * 2; };
    const wrapped = cache.wrap(fn, { keyPrefix: 'test' });

    assert.equal(await wrapped(5), 10);
    assert.equal(await wrapped(5), 10);
    assert.equal(callCount, 2);
  } finally {
    if (origHost) process.env.REDIS_HOST = origHost;
    if (origPort) process.env.REDIS_PORT = origPort;
  }
});

test('noop cache clearCache returns 0 and close does not throw', async () => {
  const origHost = process.env.REDIS_HOST;
  const origPort = process.env.REDIS_PORT;
  delete process.env.REDIS_HOST;
  delete process.env.REDIS_PORT;

  try {
    const cache = createRpcCache();
    assert.equal(await cache.clearCache(), 0);
    await cache.close();
  } finally {
    if (origHost) process.env.REDIS_HOST = origHost;
    if (origPort) process.env.REDIS_PORT = origPort;
  }
});

// ---------------------------------------------------------------------------
// Sensitive data — cache must refuse Stellar keys/seeds
// ---------------------------------------------------------------------------

test('cache refuses to store responses containing Stellar secret seeds', async () => {
  const redis = fakeRedis();
  const cache = createRpcCache({ redis });
  const setSpy = mock.method(redis, 'set');

  const wrapped = cache.wrap(
    async () => ({ secret: VALID_STELLAR_SEED }),
    { keyPrefix: 'test', ttlMs: 60_000 }
  );

  await wrapped();
  assert.equal(setSpy.mock.calls.length, 0, 'should not cache sensitive data');
  assert.equal(cache.getStats().misses, 1);
});

test('cache refuses to store responses containing Stellar account IDs with G prefix', async () => {
  const redis = fakeRedis();
  const cache = createRpcCache({ redis });
  const setSpy = mock.method(redis, 'set');

  const wrapped = cache.wrap(
    async () => ({ account: VALID_STELLAR_ACCOUNT }),
    { keyPrefix: 'test', ttlMs: 60_000 }
  );

  await wrapped();
  assert.equal(setSpy.mock.calls.length, 0, 'should not cache sensitive data');
  assert.equal(cache.getStats().misses, 1);
});

// ---------------------------------------------------------------------------
// Custom keyFn and networkFn
// ---------------------------------------------------------------------------

test('custom keyFn is used to derive the cache key', async () => {
  const redis = fakeRedis();
  const cache = createRpcCache({ redis });
  const getSpy = mock.method(redis, 'get');

  const wrapped = cache.wrap(
    async (a, b) => a + b,
    {
      keyPrefix: 'sum',
      ttlMs: 60_000,
      keyFn: (a, b) => `${a}+${b}`
    }
  );

  await wrapped(1, 2);
  assert.ok(getSpy.mock.calls[0].arguments[0].includes('1+2'));
});

test('custom networkFn overrides the default network resolver', async () => {
  const redis = fakeRedis();
  const cache = createRpcCache({ redis });
  const getSpy = mock.method(redis, 'get');

  const wrapped = cache.wrap(
    async (x) => x,
    {
      keyPrefix: 'custom-net',
      ttlMs: 60_000,
      networkFn: () => 'custom-network'
    }
  );

  await wrapped(1);
  const cacheKey = getSpy.mock.calls[0].arguments[0];
  assert.ok(cacheKey.includes('custom-network'));
});
