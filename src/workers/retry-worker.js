const { logger } = require('../logger');
const { resetStuckRetries, findDueRetries, failRetry } = require('../services/retry-tracker');
const { enqueueEvent } = require('../queue/event-queue');

const JOB_TYPE_EVENT = 'event-processing';
const POLL_INTERVAL_MS = 10_000; // Check every 10s
const BATCH_SIZE = 50;

/**
 * Async worker that resumes retries after restart.
 * Polls PostgreSQL for retries that are due and re-enqueues them.
 * Uses SKIP LOCKED so multiple worker instances don't conflict.
 */
async function startRetryWorker() {
  // On startup, reset any retries that were stuck mid-flight from a previous crash
  await resetStuckRetries(JOB_TYPE_EVENT);

  logger.info('[retry-worker] Started, polling every %d ms', POLL_INTERVAL_MS);

  const interval = setInterval(async () => {
    try {
      const due = await findDueRetries(JOB_TYPE_EVENT, BATCH_SIZE);

      if (due.length === 0) {
        return; // Nothing due
      }

      logger.info('[retry-worker] Found %d retries due for processing', due.length);

      for (const row of due) {
        try {
          await enqueueEvent(
            { eventType: 'retry.resume', originalJobId: row.job_id, retryId: row.id },
            { jobId: `retry-${row.job_id}-${row.attempt_count}` }
          );
          logger.info(
            { jobId: row.job_id, attempt: row.attempt_count },
            '[retry-worker] Re-enqueued retry'
          );
        } catch (enqueueError) {
          // If re-enqueue fails (e.g. Redis down), mark as failed so we
          // don't keep retrying the re-enqueue itself
          await failRetry(JOB_TYPE_EVENT, row.job_id, `Re-enqueue failed: ${enqueueError.message}`);
          logger.error(
            { jobId: row.job_id, error: enqueueError.message },
            '[retry-worker] Failed to re-enqueue retry, marking as failed'
          );
        }
      }
    } catch (err) {
      logger.error({ error: err.message }, '[retry-worker] Poll cycle failed');
    }
  }, POLL_INTERVAL_MS);

  // Return a shutdown function
  return {
    stop: () => {
      clearInterval(interval);
      logger.info('[retry-worker] Stopped');
    },
  };
}

module.exports = { startRetryWorker };
