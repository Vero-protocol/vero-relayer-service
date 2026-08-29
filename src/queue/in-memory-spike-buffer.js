'use strict';

// In-memory spike buffer (issue #2).
//
// When many pull requests merge simultaneously during high-volume developer
// sprints, the synchronous server execution model (BullMQ on Redis) can become
// briefly unavailable or fall behind. The previous code path dropped the event
// on `queue.add` failure, which could lose transactions (and, under Soroban
// sequence-number reuse, surface as sequence collisions). This buffer absorbs
// validated events in memory and serializes their re-enqueue with a concurrency
// of 1, so nothing is silently dropped and transaction-generation tasks stay
// ordered until the durable queue is reachable again.
//
// Trade-off: this is a volatile buffer — events held here are lost if the
// process crashes before Redis recovers. That is acceptable for short bursts
// ("buffer spikes"); for durable persistence the BullMQ/PostgreSQL retry-tracker
// remains the source of truth once connectivity returns.

function createInMemorySpikeBuffer(options = {}) {
  const buffer = [];
  let active = 0;
  const concurrency = Number.isInteger(options.concurrency) && options.concurrency >= 1
    ? options.concurrency
    : 1;
  let draining = false;
  const processor = options.processor; // async (item) => void
  const log = options.logger || console;

  async function pump() {
    if (draining) return;
    draining = true;
    try {
      while (buffer.length > 0 && active < concurrency) {
        const item = buffer.shift();
        active += 1;
        Promise.resolve()
          .then(() => (processor ? processor(item) : Promise.resolve()))
          .catch((err) =>
            log.error &&
            log.error({ err: err && err.message, jobId: item.id }, '[spike-buffer] processor failed')
          )
          .finally(() => {
            active -= 1;
          });
      }
    } finally {
      draining = false;
    }
    if (buffer.length > 0) setImmediate(pump);
  }

  return {
    enqueue(payload, meta = {}) {
      const id =
        meta && meta.id
          ? meta.id
          : `spike-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      buffer.push({ id, payload });
      setImmediate(pump);
      return id;
    },
    size() {
      return buffer.length;
    },
    active() {
      return active;
    },
    get concurrency() {
      return concurrency;
    },
  };
}

module.exports = { createInMemorySpikeBuffer };
