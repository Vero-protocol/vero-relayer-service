require('dotenv').config();

const { UnrecoverableError, Worker } = require('bullmq');
const { logger } = require('../logger');
const { registerTaskOnChain } = require('../../stellar');
const { EVENT_TYPES } = require('../queue/types');
const {
  getBullMqQueueSettings,
  getEventQueueConcurrency,
  getEventQueueName,
  getRedisConnectionOptions
} = require('../queue/redis');
const { createEventQueue } = require('../queue/event-queue');
const { createCleanupJob } = require('../queue/cleanup');
const {
  vero_events_processed_total,
  queue_latency_seconds
} = require('../metrics/metrics');
const { startConfigPoller, stopConfigPoller } = require('../services/config-poller');
const { runMigrations } = require('../db/run-migrations');
const { startRetryWorker } = require('./retry-worker');
const {
  initRetryState,
  recordRetry,
  completeRetry,
  failRetry
} = require('../services/retry-tracker');

const RETRY_JOB_TYPE = 'event-processing';

function getJobEventType(job) {
  return (job && job.data && job.data.eventType) || 'unknown';
}

function getJobAttempt(job) {
  const attempts = (job && job.opts && job.opts.attempts) || 1;
  return `${((job && job.attemptsMade) || 0) + 1}/${attempts}`;
}

function getPullRequestNumber(data) {
  return data && data.payload && data.payload.pull_request && data.payload.pull_request.number;
}

async function processEventJob(job, dependencies = {}) {
  const eventType = getJobEventType(job);
  const broadcaster = dependencies.registerTaskOnChain || registerTaskOnChain;
  const jobId = job.id;
  const maxAttempts = (job.opts && job.opts.attempts) || 5;

  // Track this job in the retry state table (idempotent via ON CONFLICT)
  try {
    await initRetryState(RETRY_JOB_TYPE, jobId, maxAttempts);
  } catch (stateErr) {
    logger.warn({ jobId, error: stateErr.message }, '[worker] Failed to init retry state (non-fatal)');
  }

  logger.info({ jobId, eventType, attempt: getJobAttempt(job) }, '[worker] Event processing started');

  if (eventType !== EVENT_TYPES.GITHUB_PULL_REQUEST_MERGED) {
    // Unrecoverable — mark as completed so we don't retry
    try {
      await completeRetry(RETRY_JOB_TYPE, jobId);
    } catch (_) { /* non-fatal */ }
    throw new UnrecoverableError(`Unsupported event type: ${eventType}`);
  }

  const pullRequestNumber = getPullRequestNumber(job.data);

  if (!Number.isInteger(pullRequestNumber)) {
    try {
      await completeRetry(RETRY_JOB_TYPE, jobId);
    } catch (_) { /* non-fatal */ }
    throw new UnrecoverableError('Invalid event payload: missing pull request number');
  }

  try {
    await broadcaster(pullRequestNumber);
  } catch (broadcastErr) {
    // Record the retry in PostgreSQL for persistence across restarts
    try {
      await recordRetry(RETRY_JOB_TYPE, jobId, broadcastErr.message);
    } catch (recErr) {
      logger.error({ jobId, error: recErr.message }, '[worker] Failed to record retry state');
    }
    throw broadcastErr; // Let BullMQ handle its own retry mechanism too
  }

  // Success — mark as completed in retry state
  try {
    await completeRetry(RETRY_JOB_TYPE, jobId);
  } catch (_) { /* non-fatal */ }

  try {
    const taskType = eventType || 'unknown';
    vero_events_processed_total.labels({ task_type: taskType }).inc();
    if (job.data && job.data.receivedAt) {
      const receivedAt = new Date(job.data.receivedAt).getTime();
      const durationSec = (Date.now() - receivedAt) / 1000;
      queue_latency_seconds.labels({ task_type: taskType }).observe(durationSec);
    }
  } catch (metricsError) {
    logger.warn({ error: metricsError.message }, 'Failed to record metrics in worker');
  }

  return {
    pr: pullRequestNumber
  };
}

function createEventWorker(options = {}) {
  const logicalQueueName = options.queueName || getEventQueueName(options.env);
  const settings = getBullMqQueueSettings(logicalQueueName);
  const concurrency = options.concurrency || getEventQueueConcurrency(options.env);
  const connection = options.connection || getRedisConnectionOptions(options.env);

  const worker = new Worker(settings.name, job => processEventJob(job, options.dependencies), {
    concurrency,
    connection,
    prefix: settings.prefix
  });

  worker.on('completed', job => {
    logger.info({ jobId: job.id, eventType: getJobEventType(job), attempt: job.attemptsMade + 1 }, '[worker] Job completed successfully');
  });

  worker.on('failed', (job, error) => {
    const jobId = job ? job.id : 'unknown';
    const eventType = job ? getJobEventType(job) : 'unknown';
    const attempt = job ? `${job.attemptsMade}/${(job.opts && job.opts.attempts) || 1}` : 'unknown';
    logger.error({ jobId, eventType, attempt, error: error.message }, '[worker] Job failed');

    // Track in PostgreSQL retry state if not already tracked by processEventJob
    // (This catches failures before processEventJob runs, e.g. job deserialization errors)
    if (job && !(error instanceof UnrecoverableError)) {
      const maxAttempts = (job.opts && job.opts.attempts) || 5;
      initRetryState(RETRY_JOB_TYPE, jobId, maxAttempts)
        .then(() => recordRetry(RETRY_JOB_TYPE, jobId, error.message))
        .catch(err => logger.error({ jobId, error: err.message }, '[worker] Failed to record retry in failed handler'));
    }
  });

  worker.on('error', error => {
    logger.error({ error: error.message }, '[worker] Error occurred');
  });

  return worker;
}

async function startEventWorker() {
  const queueName = getEventQueueName();
  const concurrency = getEventQueueConcurrency();
  const worker = createEventWorker({ queueName, concurrency });
  let retryWorkerHandle = null;
  let closing = false;

  // Run migrations to ensure retry_state table exists
  try {
    await runMigrations();
    logger.info('[worker] Database migrations complete');
  } catch (migrationErr) {
    logger.warn({ error: migrationErr.message }, '[worker] Database migrations skipped (non-fatal)');
  }

  startConfigPoller();

  // Start the async retry worker that resumes retries after restart
  try {
    const { stop } = await startRetryWorker();
    retryWorkerHandle = { stop };
    logger.info('[worker] Retry worker started');
  } catch (retryErr) {
    logger.warn({ error: retryErr.message }, '[worker] Retry worker startup failed (non-fatal)');
  }

  const cleanupQueue = createEventQueue();
  const cleanupTask = createCleanupJob(cleanupQueue, { logger });
  cleanupTask.start();
  logger.info({ queue: queueName }, 'queue cleanup job scheduled (purges stale completed and failed jobs daily at midnight UTC)');

  logger.info({ queue: queueName, concurrency }, '[worker] Started successfully');

  async function shutdown(signal) {
    if (closing) {
      return;
    }

    closing = true;
    logger.info({ signal }, '[worker] Shutdown initiated');
    cleanupTask.stop();
    stopConfigPoller();
    if (retryWorkerHandle) {
      retryWorkerHandle.stop();
    }
    await cleanupQueue.close();
    await worker.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch(error => {
      logger.error({ error: error.message }, '[worker] Shutdown failed');
      process.exit(1);
    });
  });

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch(error => {
      logger.error({ error: error.message }, '[worker] Shutdown failed');
      process.exit(1);
    });
  });

  return worker;
}

if (require.main === module) {
  startEventWorker().catch(error => {
    logger.error({ error: error.message }, '[worker] Startup failed');
    process.exit(1);
  });
}

module.exports = {
  createEventWorker,
  processEventJob,
  startEventWorker
};
