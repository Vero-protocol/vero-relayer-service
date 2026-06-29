'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
  ERROR_RATE_THRESHOLD,
  SCALE_UP_STEP,
  SCALE_DOWN_FACTOR,
  BatchSizer,
  computeNextBatchSize,
  createBatchSizer
} = require('../src/services/batch-sizer');

// ---------------------------------------------------------------------------
// Module-level constant sanity checks
// ---------------------------------------------------------------------------
test('constants have sane defaults', () => {
  assert.equal(MIN_BATCH_SIZE, 1);
  assert.equal(MAX_BATCH_SIZE, 50);
  assert.equal(DEFAULT_BATCH_SIZE, 10);
  assert.equal(ERROR_RATE_THRESHOLD, 0.2);
  assert.equal(SCALE_UP_STEP, 5);
  assert.equal(SCALE_DOWN_FACTOR, 0.5);
});

// ---------------------------------------------------------------------------
// computeNextBatchSize — scale-up
// ---------------------------------------------------------------------------
test('computeNextBatchSize scales up when queue is deeper than current size', () => {
  const next = computeNextBatchSize(10, 20, 0);
  assert.equal(next, 15); // 10 + SCALE_UP_STEP
});

test('computeNextBatchSize does not exceed maxBatchSize when scaling up', () => {
  const next = computeNextBatchSize(48, 100, 0, { maxBatchSize: 50 });
  assert.equal(next, 50);
});

test('computeNextBatchSize holds size when queue depth equals current size', () => {
  const next = computeNextBatchSize(10, 10, 0);
  assert.equal(next, 10);
});

test('computeNextBatchSize holds size when queue depth is below current size', () => {
  const next = computeNextBatchSize(15, 5, 0);
  assert.equal(next, 15);
});

// ---------------------------------------------------------------------------
// computeNextBatchSize — scale-down
// ---------------------------------------------------------------------------
test('computeNextBatchSize scales down when error rate exceeds threshold', () => {
  const next = computeNextBatchSize(20, 0, 0.5); // 50 % errors
  assert.equal(next, 10); // floor(20 * 0.5)
});

test('computeNextBatchSize floors at minBatchSize when scaling down', () => {
  const next = computeNextBatchSize(1, 0, 1.0); // 100 % errors, already at min
  assert.equal(next, 1);
});

test('computeNextBatchSize does not scale down at exactly the threshold', () => {
  // threshold is 0.2 — error rate equal to threshold should NOT trigger scale-down
  const next = computeNextBatchSize(20, 25, 0.2);
  assert.equal(next, 25); // queue deeper → scale up
});

test('computeNextBatchSize scales down just above the threshold', () => {
  const next = computeNextBatchSize(20, 0, 0.21);
  assert.equal(next, 10); // floor(20 * 0.5)
});

// ---------------------------------------------------------------------------
// computeNextBatchSize — custom options
// ---------------------------------------------------------------------------
test('custom minBatchSize and maxBatchSize are respected', () => {
  const opts = { minBatchSize: 2, maxBatchSize: 20 };
  // scale-up past custom max
  const up = computeNextBatchSize(18, 100, 0, opts);
  assert.equal(up, 20);
  // scale-down to custom min
  const down = computeNextBatchSize(2, 0, 1.0, opts);
  assert.equal(down, 2);
});

test('custom errorThreshold is honoured', () => {
  // threshold set high: 0.6 — error rate of 0.5 should NOT trigger scale-down
  const opts = { errorThreshold: 0.6, maxBatchSize: 50 };
  const next = computeNextBatchSize(10, 5, 0.5, opts);
  assert.equal(next, 10); // queue not deeper, no scale-up; error below custom threshold
});

// ---------------------------------------------------------------------------
// computeNextBatchSize — input validation
// ---------------------------------------------------------------------------
test('computeNextBatchSize throws on non-integer currentSize', () => {
  assert.throws(() => computeNextBatchSize(1.5, 0, 0), /currentSize/);
});

test('computeNextBatchSize throws on negative queueDepth', () => {
  assert.throws(() => computeNextBatchSize(10, -1, 0), /queueDepth/);
});

test('computeNextBatchSize throws on errorRate above 1', () => {
  assert.throws(() => computeNextBatchSize(10, 0, 1.1), /errorRate/);
});

test('computeNextBatchSize throws on errorRate below 0', () => {
  assert.throws(() => computeNextBatchSize(10, 0, -0.1), /errorRate/);
});

test('computeNextBatchSize throws when minBatchSize exceeds maxBatchSize', () => {
  assert.throws(
    () => computeNextBatchSize(10, 0, 0, { minBatchSize: 20, maxBatchSize: 10 }),
    /maxBatchSize/
  );
});

test('computeNextBatchSize throws on maxBatchSize above Stellar hard limit', () => {
  assert.throws(
    () => computeNextBatchSize(10, 0, 0, { maxBatchSize: 101 }),
    /maxBatchSize/
  );
});

test('computeNextBatchSize throws on NaN errorRate', () => {
  assert.throws(() => computeNextBatchSize(10, 0, Number.NaN), /errorRate/);
});

// ---------------------------------------------------------------------------
// BatchSizer class
// ---------------------------------------------------------------------------
test('BatchSizer initialises with DEFAULT_BATCH_SIZE', () => {
  const sizer = new BatchSizer();
  assert.equal(sizer.current, DEFAULT_BATCH_SIZE);
});

test('BatchSizer honours custom defaultSize option', () => {
  const sizer = new BatchSizer({ defaultSize: 25 });
  assert.equal(sizer.current, 25);
});

test('BatchSizer.next scales up and persists new size', () => {
  const sizer = new BatchSizer({ defaultSize: 10, maxBatchSize: 50 });
  const next = sizer.next(30, 0); // deep queue, no errors
  assert.equal(next, 15);
  assert.equal(sizer.current, 15);
});

test('BatchSizer.next scales down on high error rate', () => {
  const sizer = new BatchSizer({ defaultSize: 20 });
  const next = sizer.next(0, 0.9);
  assert.equal(next, 10); // floor(20 * 0.5)
  assert.equal(sizer.current, 10);
});

test('BatchSizer.reset restores default size', () => {
  const sizer = new BatchSizer({ defaultSize: 10 });
  sizer.next(100, 0); // scale up
  assert.equal(sizer.current, 15);
  sizer.reset();
  assert.equal(sizer.current, 10);
});

test('BatchSizer multiple scale-up steps accumulate', () => {
  const sizer = new BatchSizer({ defaultSize: 10, maxBatchSize: 50 });
  sizer.next(100, 0); // → 15
  sizer.next(100, 0); // → 20
  sizer.next(100, 0); // → 25
  assert.equal(sizer.current, 25);
});

test('BatchSizer scale-up then scale-down', () => {
  const sizer = new BatchSizer({ defaultSize: 10, maxBatchSize: 50 });
  sizer.next(100, 0); // → 15
  sizer.next(0, 0.9); // → floor(15 * 0.5) = 7
  assert.equal(sizer.current, 7);
});

// ---------------------------------------------------------------------------
// createBatchSizer factory
// ---------------------------------------------------------------------------
test('createBatchSizer returns a BatchSizer instance', () => {
  const sizer = createBatchSizer();
  assert.ok(sizer instanceof BatchSizer);
});

test('createBatchSizer passes options through', () => {
  const sizer = createBatchSizer({ defaultSize: 5, maxBatchSize: 30 });
  assert.equal(sizer.current, 5);
  const next = sizer.next(100, 0); // should grow capped at 30
  assert.equal(next, 10);
});

test('BatchSizer.current is read-only', () => {
  const sizer = createBatchSizer();
  assert.throws(() => { sizer.current = 99; }, TypeError);
});
