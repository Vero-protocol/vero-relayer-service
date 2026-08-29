'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fetchAccount } = require('../src/services/broadcaster');
const { NonceManager } = require('../src/relayer/nonceManager');

const silentLogger = { debug() {}, error() {} };

function createAdvisoryLockPool() {
  const held = new Set();
  const queues = new Map();

  async function acquire(key) {
    if (!held.has(key)) {
      held.add(key);
      return;
    }

    await new Promise(resolve => {
      const queue = queues.get(key) || [];
      queue.push(resolve);
      queues.set(key, queue);
    });
  }

  function unlock(key) {
    const queue = queues.get(key) || [];
    const next = queue.shift();

    if (next) {
      next();
    } else {
      held.delete(key);
      queues.delete(key);
    }
  }

  return {
    async connect() {
      return {
        async query(sql, [key]) {
          if (sql.includes('pg_advisory_unlock')) {
            unlock(key);
          } else if (sql.includes('pg_advisory_lock')) {
            await acquire(key);
          }
        },
        release() {}
      };
    }
  };
}

test('fetchAccount bypasses the account cache when requested', async () => {
  let sequence = 100;
  let calls = 0;
  const server = {
    async loadAccount() {
      calls += 1;
      return { sequence: String(sequence++) };
    }
  };

  const first = await fetchAccount(server, 'GRELAYER', { bypassCache: true });
  const second = await fetchAccount(server, 'GRELAYER', { bypassCache: true });

  assert.equal(first.sequence, '100');
  assert.equal(second.sequence, '101');
  assert.equal(calls, 2);
});

test('five concurrent nonce operations receive distinct account sequences', async () => {
  const nonceManager = new NonceManager({
    pool: createAdvisoryLockPool(),
    logger: silentLogger
  });

  let onChainSequence = 700;
  let cachedAccount = null;
  const observed = [];

  async function cacheAwareFetch(options = {}) {
    if (!options.bypassCache && cachedAccount) {
      return cachedAccount;
    }

    const account = { sequence: String(onChainSequence) };
    if (!options.bypassCache) {
      cachedAccount = account;
    }
    return account;
  }

  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      nonceManager.withSequentialNonce(
        'GRELAYER',
        cacheAwareFetch,
        async account => {
          observed.push(Number(account.sequence));
          onChainSequence = Number(account.sequence) + 1;
          await new Promise(resolve => setImmediate(resolve));
          return { hash: `tx-${index}` };
        }
      )
    )
  );

  assert.equal(new Set(observed).size, 5);
  assert.deepEqual([...observed].sort((a, b) => a - b), [700, 701, 702, 703, 704]);
});

test('releases the advisory lock when submission fails', async () => {
  const events = [];
  const pool = {
    async connect() {
      return {
        async query(sql) {
          events.push(sql.includes('pg_advisory_unlock') ? 'unlock' : 'lock');
        },
        release() {
          events.push('release');
        }
      };
    }
  };

  const nonceManager = new NonceManager({ pool, logger: silentLogger });

  await assert.rejects(
    () => nonceManager.withSequentialNonce(
      'GRELAYER',
      async options => {
        assert.equal(options.bypassCache, true);
        return { sequence: '1' };
      },
      async () => {
        throw new Error('submit failed');
      }
    ),
    /submit failed/
  );

  assert.deepEqual(events, ['lock', 'unlock', 'release']);
});
