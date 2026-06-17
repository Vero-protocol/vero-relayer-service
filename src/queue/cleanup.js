const cron = require('node-cron');
const { createLogger } = require('../logger');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_LIMIT = 1000;
const DAILY_MIDNIGHT = '0 0 * * *';

async function cleanFailedJobs(queue, options = {}) {
  const logger = options.logger || createLogger();
  const grace = options.grace !== undefined ? options.grace : SEVEN_DAYS_MS;
  const limit = options.limit !== undefined ? options.limit : CLEANUP_BATCH_LIMIT;

  logger.info({ queue: queue.name, graceMs: grace, limit }, 'queue cleanup started');

  const removed = await queue.clean(grace, limit, 'failed');
  const count = Array.isArray(removed) ? removed.length : 0;

  logger.info({ queue: queue.name, removed: count }, 'queue cleanup completed');

  return removed;
}

function createCleanupJob(queue, options = {}) {
  const logger = options.logger || createLogger();
  const schedule = options.schedule || DAILY_MIDNIGHT;
  const timezone = options.timezone || 'UTC';

  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron expression: ${schedule}`);
  }

  const task = cron.schedule(
    schedule,
    async () => {
      try {
        await cleanFailedJobs(queue, { logger, grace: options.grace, limit: options.limit });
      } catch (error) {
        logger.error({ queue: queue.name, error: error.message }, 'queue cleanup failed');
      }
    },
    { scheduled: false, timezone }
  );

  return task;
}

module.exports = {
  CLEANUP_BATCH_LIMIT,
  SEVEN_DAYS_MS,
  cleanFailedJobs,
  createCleanupJob
};
