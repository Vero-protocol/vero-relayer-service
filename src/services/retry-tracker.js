const { pool } = require('../db/client');
const { logger } = require('../logger');

const RETRY_BACKOFFS = [5_000, 15_000, 45_000, 120_000, 300_000]; // 5s, 15s, 45s, 2m, 5m

/**
 * Tracks retry state in PostgreSQL so retry cycles survive service restarts.
 * Designed for use with BullMQ job processing: records attempt count,
 * schedules next_retry_at, and provides a worker to resume timed-out retries.
 */
async function initRetryState(jobType, jobId, maxAttempts = 5) {
  await pool.query(
    `INSERT INTO retry_state (job_type, job_id, max_attempts, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (job_type, job_id) DO NOTHING`,
    [jobType, String(jobId), maxAttempts]
  );
}

async function getRetryState(jobType, jobId) {
  const { rows } = await pool.query(
    `SELECT id, job_type, job_id, attempt_count, max_attempts,
            last_error, next_retry_at, status, created_at, updated_at
     FROM retry_state
     WHERE job_type = $1 AND job_id = $2`,
    [jobType, String(jobId)]
  );
  return rows[0] || null;
}

/**
 * Record a retry attempt: increment attempt_count, set status to 'retrying',
 * and schedule next_retry_at based on exponential backoff.
 */
async function recordRetry(jobType, jobId, errorMessage) {
  const state = await getRetryState(jobType, jobId);

  if (!state) {
    // Auto-init if not yet tracked (defensive; initRetryState should be
    // called at enqueue time, but we handle the case gracefully)
    await initRetryState(jobType, jobId);
    return recordRetry(jobType, jobId, errorMessage);
  }

  const newAttemptCount = state.attempt_count + 1;
  const backoffIndex = Math.min(newAttemptCount - 1, RETRY_BACKOFFS.length - 1);
  const delayMs = RETRY_BACKOFFS[backoffIndex];
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString();

  const status = newAttemptCount >= state.max_attempts ? 'failed' : 'retrying';

  await pool.query(
    `UPDATE retry_state
     SET attempt_count = $1,
         last_error = $2,
         next_retry_at = $3,
         status = $4,
         updated_at = NOW()
     WHERE id = $5`,
    [newAttemptCount, errorMessage, nextRetryAt, status, state.id]
  );

  logger.warn(
    { jobType, jobId, attempt: newAttemptCount, maxAttempts: state.max_attempts, nextRetryAt, status },
    '[retry-tracker] Retry recorded'
  );

  return {
    attemptCount: newAttemptCount,
    maxAttempts: state.max_attempts,
    nextRetryAt,
    status,
    delayMs
  };
}

/**
 * Mark a job as completed (successful processing).
 */
async function completeRetry(jobType, jobId) {
  const { rowCount } = await pool.query(
    `UPDATE retry_state
     SET status = 'completed',
         next_retry_at = NULL,
         updated_at = NOW()
     WHERE job_type = $1 AND job_id = $2`,
    [jobType, String(jobId)]
  );

  if (rowCount > 0) {
    logger.info({ jobType, jobId }, '[retry-tracker] Marked as completed');
  }
}

/**
 * Mark a job as permanently failed (exhausted all retries).
 */
async function failRetry(jobType, jobId, errorMessage) {
  await pool.query(
    `UPDATE retry_state
     SET status = 'failed',
         attempt_count = max_attempts,
         last_error = $1,
         next_retry_at = NULL,
         updated_at = NOW()
     WHERE job_type = $2 AND job_id = $3`,
    [errorMessage, jobType, String(jobId)]
  );

  logger.error({ jobType, jobId, error: errorMessage }, '[retry-tracker] Permanently failed');
}

/**
 * Find retries that are due for processing (status='retrying' and
 * next_retry_at <= NOW()). Used by the async retry worker.
 */
async function findDueRetries(jobType, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, job_type, job_id, attempt_count, max_attempts,
            last_error, next_retry_at, status, created_at, updated_at
     FROM retry_state
     WHERE job_type = $1
       AND status = 'retrying'
       AND next_retry_at <= NOW()
     ORDER BY next_retry_at ASC
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [jobType, limit]
  );
  return rows;
}

/**
 * Reset stuck retries that were in 'retrying' state with a past next_retry_at
 * (e.g. after a crash). Moves them back to 'pending' so the worker picks them up.
 */
async function resetStuckRetries(jobType) {
  const { rowCount } = await pool.query(
    `UPDATE retry_state
     SET status = 'pending',
         next_retry_at = NOW(),
         updated_at = NOW()
     WHERE job_type = $1
       AND status = 'retrying'
       AND next_retry_at < NOW() - INTERVAL '5 minutes'`,
    [jobType]
  );

  if (rowCount > 0) {
    logger.info({ jobType, count: rowCount }, '[retry-tracker] Reset stuck retries after restart');
  }

  return rowCount;
}

module.exports = {
  initRetryState,
  getRetryState,
  recordRetry,
  completeRetry,
  failRetry,
  findDueRetries,
  resetStuckRetries,
  RETRY_BACKOFFS,
};
