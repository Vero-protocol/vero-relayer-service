import cron from 'node-cron';
import { pool as defaultPool } from '../db/client';
import { logger } from '../logger';

/**
 * Purge tasks in failed state older than 7 days.
 * Emits audit log lines before/after each run for compliance.
 *
 * @param pool - Optional pg pool to inject (defaults to the shared singleton pool)
 */
export async function purgeFailedTasks(pool = defaultPool): Promise<number> {
  logger.info(
    { action: 'database_cleanup_start' },
    'Database cleanup job started: purging failed tasks older than 7 days.'
  );

  const client = await pool.connect();
  try {
    const queryText = `
      DELETE FROM tasks
      WHERE status = 'failed'
        AND created_at < NOW() - INTERVAL '7 days';
    `;
    const result = await client.query(queryText);
    const deletedCount = result.rowCount ?? 0;

    logger.info(
      { action: 'database_cleanup_complete', deletedCount },
      `Database cleanup job completed. Purged ${deletedCount} stale failed tasks.`
    );

    return deletedCount;
  } catch (error: any) {
    logger.error(
      { action: 'database_cleanup_failed', error: error.message },
      `Database cleanup job failed: ${error.message}`
    );
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Create and schedule the cleanup worker cron job.
 * Cleanup failures are caught and logged — a single bad run never crashes the worker.
 *
 * @param options.schedule  Cron expression (defaults to daily midnight UTC)
 * @param options.pool      pg Pool override (for testing / dependency injection)
 */
export function startCleanupWorker(options: {
  schedule?: string;
  pool?: typeof defaultPool;
} = {}) {
  const schedule = options.schedule ?? '0 0 * * *';
  const pool = options.pool ?? defaultPool;

  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron expression: ${schedule}`);
  }

  logger.info(
    { action: 'cleanup_worker_scheduled', schedule },
    `Scheduling cleanupWorker to run at interval: ${schedule}`
  );

  const task = cron.schedule(schedule, async () => {
    try {
      await purgeFailedTasks(pool);
    } catch (err) {
      // Logged inside purgeFailedTasks — swallowed here so the worker stays alive.
    }
  });

  return task;
}
