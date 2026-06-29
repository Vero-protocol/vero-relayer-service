/**
 * Windowed event batcher for Stellar multi-op transactions.
 *
 * Aggregates incoming PR IDs and flushes them as a single multi-op
 * transaction when either:
 *   - the adaptive batch size limit has been reached, or
 *   - WINDOW_MS milliseconds have elapsed since the first enqueue.
 *
 * Batch size is managed by BatchSizer, which scales it up when the
 * queue is deep and scales it down when the error rate is elevated.
 *
 * Security: MAX_BATCH_SIZE caps batch size to prevent transaction bloat
 * (Stellar enforces a hard limit of 100 ops per transaction).
 */

const { logger } = require('../logger');
const { createBatchSizer } = require('../services/batch-sizer');

type FlushFn = (ids: number[]) => Promise<void>;

const MAX_BATCH_SIZE = 50; // hard cap — Stellar max is 100 ops
const WINDOW_MS = 5_000;   // 5-second aggregation window

export class EventBatcher {
  private queue: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private errorCount = 0;
  private flushCount = 0;
  private readonly sizer = createBatchSizer({ maxBatchSize: MAX_BATCH_SIZE });

  constructor(private readonly flush: FlushFn) {}

  enqueue(prId: number): void {
    this.queue.push(prId);
    if (!this.timer) {
      this.timer = setTimeout(() => this.drain(), WINDOW_MS);
    }
    const batchSize = this.sizer.next(this.queue.length, this._errorRate());
    if (this.queue.length >= batchSize) {
      this.drain();
    }
  }

  private _errorRate(): number {
    const total = this.flushCount;
    return total === 0 ? 0 : this.errorCount / total;
  }

  private drain(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    this.flushCount += 1;
    this.flush(batch).catch(err => {
      this.errorCount += 1;
      logger.error({ err }, '[batcher] flush error');
    });
  }
}
