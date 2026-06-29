-- Retry state persistence for transaction processing.
-- Tracks attempt_count and next_retry for each job so retries
-- survive service restarts and can be resumed by the async worker.
CREATE TABLE IF NOT EXISTS retry_state (
    id              BIGSERIAL PRIMARY KEY,
    job_type        VARCHAR(64) NOT NULL,
    job_id          VARCHAR(128) NOT NULL,
    attempt_count   SMALLINT NOT NULL DEFAULT 0,
    max_attempts    SMALLINT NOT NULL DEFAULT 5,
    last_error      TEXT,
    next_retry_at   TIMESTAMPTZ,
    status          VARCHAR(16) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'retrying', 'completed', 'failed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint so we never create duplicate tracking rows for the same job
CREATE UNIQUE INDEX IF NOT EXISTS idx_retry_state_job ON retry_state (job_type, job_id);

-- Index for the retry worker: find retries that are due for processing
CREATE INDEX IF NOT EXISTS idx_retry_state_next_retry
    ON retry_state (next_retry_at, status)
    WHERE status = 'retrying';
