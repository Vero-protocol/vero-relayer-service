'use strict';

/**
 * Adaptive batch sizer for the Stellar event worker.
 *
 * Scales the working batch size up or down based on two signals:
 *   - queue depth: more waiting jobs → larger batches (throughput mode)
 *   - recent error rate: too many failures → smaller batches (safety mode)
 *
 * Security: all inputs are validated so size math never produces NaN,
 * negative, or out-of-range values.
 *
 * Stellar hard-limits a transaction to 100 operations, so MAX_BATCH_SIZE
 * must never exceed that value.
 */

const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 50; // conservative cap; Stellar max is 100 ops
const DEFAULT_BATCH_SIZE = 10;

// Error rate above this threshold triggers a size reduction
const ERROR_RATE_THRESHOLD = 0.2; // 20 %

// Scale-up step when queue is deep and errors are low
const SCALE_UP_STEP = 5;

// Scale-down factor applied on elevated error rate
const SCALE_DOWN_FACTOR = 0.5;

/**
 * @typedef {Object} BatchSizerOptions
 * @property {number} [minBatchSize]    - Floor for computed batch size (default: 1)
 * @property {number} [maxBatchSize]    - Ceiling (default: 50, never above 100)
 * @property {number} [defaultSize]     - Starting batch size (default: 10)
 * @property {number} [errorThreshold] - Error rate [0–1] above which size shrinks (default: 0.2)
 */

/**
 * Validate that a value is a finite integer in [lo, hi].
 * @param {string} name
 * @param {unknown} value
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function validateInteger(name, value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < lo || n > hi) {
    throw new RangeError(`${name} must be an integer between ${lo} and ${hi}, got ${value}`);
  }
  return n;
}

/**
 * Validate a probability value in [0, 1].
 * @param {string} name
 * @param {unknown} value
 * @returns {number}
 */
function validateRate(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new RangeError(`${name} must be a number between 0 and 1, got ${value}`);
  }
  return n;
}

/**
 * Compute the next batch size given current queue conditions.
 *
 * Algorithm:
 *   1. If errorRate > errorThreshold → halve current size (floor at min).
 *   2. Else if queueDepth > currentSize → grow by SCALE_UP_STEP (cap at max).
 *   3. Else → keep current size.
 *
 * @param {number} currentSize   - Current working batch size
 * @param {number} queueDepth    - Number of jobs waiting in the queue
 * @param {number} errorRate     - Fraction of recent jobs that failed [0–1]
 * @param {BatchSizerOptions} [options]
 * @returns {number} Next batch size
 */
function computeNextBatchSize(currentSize, queueDepth, errorRate, options = {}) {
  const min = options.minBatchSize !== undefined
    ? validateInteger('minBatchSize', options.minBatchSize, 1, 100)
    : MIN_BATCH_SIZE;

  const max = options.maxBatchSize !== undefined
    ? validateInteger('maxBatchSize', options.maxBatchSize, min, 100)
    : MAX_BATCH_SIZE;

  const threshold = options.errorThreshold !== undefined
    ? validateRate('errorThreshold', options.errorThreshold)
    : ERROR_RATE_THRESHOLD;

  const size = validateInteger('currentSize', currentSize, min, max);
  const depth = validateInteger('queueDepth', queueDepth, 0, Number.MAX_SAFE_INTEGER);
  const rate = validateRate('errorRate', errorRate);

  if (rate > threshold) {
    // Error rate is elevated — shrink to reduce blast radius
    return Math.max(min, Math.floor(size * SCALE_DOWN_FACTOR));
  }

  if (depth > size) {
    // Queue is backing up and errors are low — grow towards the cap
    return Math.min(max, size + SCALE_UP_STEP);
  }

  return size;
}

/**
 * Stateful batch sizer that tracks the current size across calls.
 *
 * Usage:
 *   const sizer = createBatchSizer();
 *   const size = sizer.next(queueDepth, errorRate);
 */
class BatchSizer {
  /**
   * @param {BatchSizerOptions} [options]
   */
  constructor(options = {}) {
    this._options = options;
    this._current = options.defaultSize !== undefined
      ? validateInteger('defaultSize', options.defaultSize, 1, 100)
      : DEFAULT_BATCH_SIZE;
  }

  /** Current batch size (read-only snapshot). */
  get current() {
    return this._current;
  }

  /**
   * Compute and store the next batch size.
   * @param {number} queueDepth
   * @param {number} errorRate
   * @returns {number}
   */
  next(queueDepth, errorRate) {
    this._current = computeNextBatchSize(
      this._current,
      queueDepth,
      errorRate,
      this._options
    );
    return this._current;
  }

  /** Reset to the configured default size. */
  reset() {
    this._current = this._options.defaultSize !== undefined
      ? validateInteger('defaultSize', this._options.defaultSize, 1, 100)
      : DEFAULT_BATCH_SIZE;
  }
}

/**
 * Factory helper — preferred over `new BatchSizer()` in application code.
 * @param {BatchSizerOptions} [options]
 * @returns {BatchSizer}
 */
function createBatchSizer(options = {}) {
  return new BatchSizer(options);
}

module.exports = {
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
  ERROR_RATE_THRESHOLD,
  SCALE_UP_STEP,
  SCALE_DOWN_FACTOR,
  BatchSizer,
  computeNextBatchSize,
  createBatchSizer
};
