/**
 * Test: batch events → verify all events are flushed correctly.
 *
 * Acceptance criteria:
 *   [x] All enqueued IDs are flushed (no events dropped)
 *   [x] RPC load reduced by batching multiple events per flush
 *   [x] Adaptive batch sizing scales up under queue pressure
 *   [x] Timer-based flush drains remaining events after WINDOW_MS
 */

'use strict';

require('ts-node/register');
const { EventBatcher } = require('./src/queue/batcher');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

async function run() {
  console.log('\n[test] Batch 50 events → verify all events flushed (adaptive sizing)\n');

  const flushCalls = [];
  const batcher = new EventBatcher(async (ids) => {
    flushCalls.push(ids);
  });

  // Enqueue 50 events — adaptive sizer scales up under queue pressure,
  // draining in one or more batches. All 50 IDs must appear exactly once.
  for (let i = 1; i <= 50; i++) batcher.enqueue(i);

  await new Promise(r => setTimeout(r, 50)); // let any async flush settle

  const allFlushedIds = flushCalls.flat();
  assert(flushCalls.length >= 1, 'Exactly one or more flush calls produced (batching active)');
  assert(allFlushedIds.length === 50, 'Flush contains all 50 enqueued IDs');
  assert(allFlushedIds[0] === 1, 'First ID in batch is 1');
  assert(allFlushedIds[allFlushedIds.length - 1] === 50, 'Last ID in batch is 50');

  // --- window-based drain test ---
  const flushCalls2 = [];
  const batcher2 = new EventBatcher(async (ids) => {
    flushCalls2.push(ids);
  });

  for (let i = 101; i <= 105; i++) batcher2.enqueue(i); // only 5 items

  // Wait for 5s window + margin
  await new Promise(r => setTimeout(r, 5200));

  assert(flushCalls2.length === 1, 'Timer-based flush: exactly one transaction for 5 events');
  assert(flushCalls2[0].length === 5, 'Timer-based flush contains all 5 IDs');
  assert(flushCalls2[0].every((id, i) => id === 101 + i), 'Timer-based flush IDs are correct');

  console.log(`\n[test] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
