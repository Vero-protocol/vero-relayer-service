const assert = require('node:assert/strict');
const { test } = require('node:test');

const { pool } = require('../src/db/client');
const {
  DEFAULT_RETRY_BACKOFFS_MS,
  getRetryBackoffsMs,
  recordRetry
} = require('../src/services/retry-tracker');

test('getRetryBackoffsMs falls back to the default persisted-retry schedule', () => {
  const backoffs = getRetryBackoffsMs({});

  assert.deepEqual(backoffs, DEFAULT_RETRY_BACKOFFS_MS);
  assert.notEqual(backoffs, DEFAULT_RETRY_BACKOFFS_MS, 'callers should receive a copy of the defaults');
});

test('getRetryBackoffsMs parses RETRY_BACKOFFS_MS as a comma-separated millisecond schedule', () => {
  assert.deepEqual(
    getRetryBackoffsMs({ RETRY_BACKOFFS_MS: '1000, 2500,5000' }),
    [1000, 2500, 5000]
  );
});

test('getRetryBackoffsMs rejects invalid RETRY_BACKOFFS_MS entries', () => {
  for (const invalidValue of ['1000,0', '1000,-5', '1000,not-a-number', '1000,1.5', '1000, ']) {
    assert.throws(
      () => getRetryBackoffsMs({ RETRY_BACKOFFS_MS: invalidValue }),
      /RETRY_BACKOFFS_MS must be a comma-separated list of positive integers/,
      `expected ${invalidValue} to be rejected`
    );
  }
});

test('recordRetry schedules retries using the RETRY_BACKOFFS_MS override', async (t) => {
  const originalQuery = pool.query;
  const originalBackoffs = process.env.RETRY_BACKOFFS_MS;
  const queries = [];

  process.env.RETRY_BACKOFFS_MS = '25,50,75';

  pool.query = async (queryText, params) => {
    queries.push({ queryText, params });

    if (/SELECT id, job_type, job_id, attempt_count/.test(queryText)) {
      return {
        rows: [{
          id: 123,
          job_type: 'event-processing',
          job_id: 'job-1',
          attempt_count: 1,
          max_attempts: 5,
          last_error: null,
          next_retry_at: null,
          status: 'pending'
        }]
      };
    }

    if (/UPDATE retry_state/.test(queryText)) {
      return { rowCount: 1, rows: [] };
    }

    throw new Error(`Unexpected query: ${queryText}`);
  };

  t.after(() => {
    pool.query = originalQuery;
    if (originalBackoffs === undefined) {
      delete process.env.RETRY_BACKOFFS_MS;
    } else {
      process.env.RETRY_BACKOFFS_MS = originalBackoffs;
    }
  });

  const before = Date.now();
  const result = await recordRetry('event-processing', 'job-1', 'boom');
  const after = Date.now();
  const update = queries.find(({ queryText }) => /UPDATE retry_state/.test(queryText));

  assert.equal(result.attemptCount, 2);
  assert.equal(result.delayMs, 50);
  assert.equal(result.status, 'retrying');
  assert.ok(update, 'retry state should be updated');
  assert.equal(update.params[0], 2);
  assert.equal(update.params[1], 'boom');
  assert.equal(update.params[3], 'retrying');
  assert.equal(update.params[4], 123);

  const scheduledAt = new Date(result.nextRetryAt).getTime();
  assert.ok(scheduledAt >= before + 50, 'nextRetryAt should include the configured delay');
  assert.ok(scheduledAt <= after + 1000, 'nextRetryAt should be close to the configured delay');
});

// resetStuckRetries is the crash-recovery path: the retry worker calls it on
// startup to resume retries interrupted by a restart. It used to move rows to
// status 'pending', but findDueRetries selects only status = 'retrying' and
// nothing transitions 'pending' back — so the function meant to resume retries
// silently killed them. A worker killed with N merged PRs mid-retry would
// strand all N, and those PRs would never reach the chain, with nothing logged.
test('resetStuckRetries leaves rows in a status findDueRetries actually reads', async () => {
  const originalQuery = pool.query;
  const captured = [];

  pool.query = async (queryText, params) => {
    captured.push({ queryText, params });
    return { rows: [], rowCount: 0 };
  };

  try {
    const { resetStuckRetries, findDueRetries } = require('../src/services/retry-tracker');

    await resetStuckRetries('event');
    const resetSql = captured[0].queryText;

    captured.length = 0;
    await findDueRetries('event');
    const findSql = captured[0].queryText;

    // Whatever status the reset leaves behind must be one the finder selects.
    const findStatus = /status\s*=\s*'([a-z]+)'/.exec(findSql);
    assert.ok(findStatus, 'findDueRetries should filter on a status');

    const resetWritesStatus = /SET[\s\S]*?status\s*=\s*'([a-z]+)'/.exec(resetSql);
    if (resetWritesStatus) {
      assert.equal(
        resetWritesStatus[1],
        findStatus[1],
        `resetStuckRetries writes status '${resetWritesStatus[1]}' but findDueRetries only reads '${findStatus[1]}' — reset rows would never be picked up`
      );
    }

    // It must also make them due again.
    assert.match(resetSql, /next_retry_at\s*=\s*NOW\(\)/);
  } finally {
    pool.query = originalQuery;
  }
});
