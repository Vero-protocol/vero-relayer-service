'use strict';

require('ts-node/register');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventBatcher } = require('../src/queue/batcher');

test('batch 50 events → verify all events flushed (adaptive sizing)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  const flushCalls = [];
  const batcher = new EventBatcher(async (ids) => {
    flushCalls.push(ids);
  });

  for (let i = 1; i <= 50; i++) batcher.enqueue(i);

  t.mock.timers.runAll();

  const allFlushedIds = flushCalls.flat();
  assert.ok(flushCalls.length >= 1, 'one or more flush calls produced (batching active)');
  assert.equal(allFlushedIds.length, 50, 'flush contains all 50 enqueued IDs');
  assert.equal(allFlushedIds[0], 1, 'first ID in batch is 1');
  assert.equal(allFlushedIds[allFlushedIds.length - 1], 50, 'last ID in batch is 50');
});

test('timer-based window drain flushes remaining events after WINDOW_MS', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  const flushCalls = [];
  const batcher = new EventBatcher(async (ids) => {
    flushCalls.push(ids);
  });

  for (let i = 101; i <= 105; i++) batcher.enqueue(i);

  assert.equal(flushCalls.length, 0, 'no flush before window expires');

  t.mock.timers.tick(5000);

  assert.equal(flushCalls.length, 1, 'timer-based flush: exactly one transaction for 5 events');
  assert.equal(flushCalls[0].length, 5, 'timer-based flush contains all 5 IDs');
  assert.deepEqual(flushCalls[0], [101, 102, 103, 104, 105], 'timer-based flush IDs are correct');
});
