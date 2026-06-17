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
const { logger } = require('../logger');

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

  logger.info({ jobId: job.id, eventType, attempt: getJobAttempt(job) }, 'worker job started');

  if (eventType !== EVENT_TYPES.GITHUB_PULL_REQUEST_MERGED) {
    throw new UnrecoverableError(`Unsupported event type: ${eventType}`);
  }

  const pullRequestNumber = getPullRequestNumber(job.data);

  if (!Number.isInteger(pullRequestNumber)) {
    throw new UnrecoverableError('Invalid event payload: missing pull request number');
  }

  await broadcaster(pullRequestNumber);

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
    logger.info({ jobId: job.id, eventType: getJobEventType(job), attempt: job.attemptsMade + 1 }, 'worker job completed');
  });

  worker.on('failed', (job, error) => {
    const jobId = job ? job.id : 'unknown';
    const eventType = job ? getJobEventType(job) : 'unknown';
    const attempt = job ? `${job.attemptsMade}/${(job.opts && job.opts.attempts) || 1}` : 'unknown';
    logger.error({ jobId, eventType, attempt, error: error.message }, 'worker job failed');
  });

  worker.on('error', error => {
    logger.error({ error: error.message }, 'worker error');
  });

  return worker;
}

async function startEventWorker() {
  const queueName = getEventQueueName();
  const concurrency = getEventQueueConcurrency();
  const worker = createEventWorker({ queueName, concurrency });
  let closing = false;

  const cleanupQueue = createEventQueue();
  const cleanupTask = createCleanupJob(cleanupQueue, { logger });
  cleanupTask.start();
  logger.info({ queue: queueName }, 'queue cleanup job scheduled (daily at midnight UTC)');

  logger.info({ queueName, concurrency }, 'worker started');

  async function shutdown(signal) {
    if (closing) {
      return;
    }

    closing = true;
    logger.info({ signal }, 'worker shutting down');
    await worker.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch(error => {
      logger.error({ error: error.message }, 'worker shutdown failed');
      process.exit(1);
    });
  });

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch(error => {
      logger.error({ error: error.message }, 'worker shutdown failed');
      process.exit(1);
    });
  });

  return worker;
}

if (require.main === module) {
  startEventWorker().catch(error => {
    logger.error({ error: error.message }, 'worker startup failed');
    process.exit(1);
  });
}

module.exports = {
  createEventWorker,
  processEventJob,
  startEventWorker
};
