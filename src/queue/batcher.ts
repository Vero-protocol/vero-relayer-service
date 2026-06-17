/**
 * Windowed event batcher for Stellar multi-op transactions.
 *
 * Aggregates incoming PR IDs and flushes them as a single multi-op
 * transaction when either:
 *   - MAX_BATCH_SIZE events have accumulated, or
 *   - WINDOW_MS milliseconds have elapsed since the first enqueue.
 *
 * Security: MAX_BATCH_SIZE caps batch size to prevent transaction bloat
 * (Stellar enforces a hard limit of 100 ops per transaction).
 */

const { logger } = require('../logger');

type FlushFn = (ids: number[]) => Promise<void>;

const MAX_BATCH_SIZE = 50; // hard cap — Stellar max is 100 ops
const WINDOW_MS = 5_000;   // 5-second aggregation window

export class EventBatcher {
  private queue: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly flush: FlushFn) {}

  enqueue(prId: number): void {
    this.queue.push(prId);
    if (!this.timer) {
      this.timer = setTimeout(() => this.drain(), WINDOW_MS);
    }
    if (this.queue.length >= MAX_BATCH_SIZE) {
      this.drain();
    }
  }

  private drain(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    this.flush(batch).catch(err =>
      logger.error({ err }, '[batcher] flush error')
    );
  }
}
