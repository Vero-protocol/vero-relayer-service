const crypto = require('crypto');
const express = require('express');
const { verifySignature } = require('./src/middleware/auth');
const { verifyJwtBearer } = require('./src/middleware/jwt-auth');
const { validateTaskPayload } = require('./src/middleware/validator');
const {
  buildGitHubPullRequestEventPayload,
  buildMetadataFromRequest,
  enqueueEvent,
  validateRedisConfig
} = require('./src/queue');
const { storeRawEvent, fetchRawEvent } = require('./src/queue/raw-event-store');
const { registerMetrics } = require('./src/metrics/metrics');
const { enforceIdempotency } = require('./src/middleware/idempotency');
const { logger } = require('./src/logger');
const { startConfigPoller } = require('./src/services/config-poller');
const { ingestRateLimiter } = require('./src/middleware/rateLimit');
const { runMigrations } = require('./src/db/run-migrations');
const { healthCheck: dbHealthCheck, getPoolMetrics } = require('./src/db/client');

function createApp(options = {}) {
  const enqueueEventJob = options.enqueueEventJob || enqueueEvent;
  const storeRawEventFn = options.storeRawEvent || storeRawEvent;
  const fetchRawEventFn = options.fetchRawEvent || fetchRawEvent;
  const idempotencyMiddleware = options.idempotencyMiddleware || enforceIdempotency;
  const app = express();

  // Trust the first proxy hop so X-Forwarded-For is used to resolve the real
  // client IP — required for accurate per-IP rate limiting behind a load balancer.
  app.set('trust proxy', 1);

  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  registerMetrics(app);

  app.get('/health', async (req, res) => {
    try {
      const dbHealth = await dbHealthCheck();
      const poolMetrics = getPoolMetrics();
      
      if (dbHealth.healthy) {
        return res.status(200).json({
          status: 'OK',
          timestamp: new Date().toISOString(),
          database: {
            healthy: true,
            latencyMs: dbHealth.latencyMs,
            pool: poolMetrics,
          },
        });
      } else {
        return res.status(503).json({
          status: 'DEGRADED',
          timestamp: new Date().toISOString(),
          database: {
            healthy: false,
            error: dbHealth.error,
            pool: poolMetrics,
          },
        });
      }
    } catch (error) {
      logger.error({ error: error.message }, '[health] Health check failed');
      return res.status(503).json({
        status: 'ERROR',
        timestamp: new Date().toISOString(),
        error: error.message,
      });
    }
  });

  // GitHub webhook — middleware order is intentional:
  //   rate-limit → signature verify → payload validate → idempotency dedupe → handler
  // Validate comes after signature verification (trust) and BEFORE idempotency
  // dedupe so that malformed payloads are rejected with 400 instead of being
  // silently remembered under their Idempotency-Key (which would later return
  // a confusing 409 instead of 400).
  app.post('/github-webhook', ingestRateLimiter, verifySignature, validateTaskPayload, idempotencyMiddleware, async (req, res) => {
    const { action, pull_request: pr } = req.body;
    if (action !== 'closed' || !pr?.merged) {
      return res.status(200).json({ skipped: true });
    }

    const hasLabel = pr.labels?.some(label => label.name === 'wave-contribution');
    if (!hasLabel) {
      return res.status(200).json({ skipped: true, reason: 'no wave-contribution label' });
    }

    try {
      const metadata = buildMetadataFromRequest(req);
      await storeRawEventFn(req.body, metadata);
      const eventPayload = buildGitHubPullRequestEventPayload(req.body, metadata);
      const job = await enqueueEventJob(eventPayload);
      logger.info({ pr: pr.number, eventType: eventPayload.eventType, jobId: job.id }, '[webhook] queued PR event');
      return res.status(202).json({ ok: true, pr: pr.number, queued: true, jobId: job.id });
    } catch (error) {
      logger.error({ pr: pr.number, error: error.message }, '[webhook] failed to enqueue PR');
      return res.status(500).json({ ok: false, error: 'failed to enqueue event' });
    }
  });

  // Internal replay endpoint reads a previously-ingested payload from the raw
  // event store. Such payloads were already validated at ingest time and are
  // fetched by Idempotency-Key from Redis, so we intentionally do NOT re-run
  // validateTaskPayload here — the Idempotency-Key is the sole input.
  app.post('/internal/webhooks/replay', verifyJwtBearer, async (req, res) => {
    const { idempotencyKey } = req.body;

    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return res.status(400).json({ ok: false, error: 'idempotencyKey is required' });
    }

    try {
      const stored = await fetchRawEventFn(idempotencyKey);

      if (!stored) {
        return res.status(404).json({ ok: false, error: 'raw event not found' });
      }

      const eventPayload = buildGitHubPullRequestEventPayload(stored.rawEvent, stored.metadata);
      const job = await enqueueEventJob(eventPayload, { jobId: `replay-${crypto.createHash('sha256').update(idempotencyKey).digest('hex')}` });

      logger.info({ idempotencyKey, queueJobId: job.id }, '[webhook] replayed raw event');
      return res.status(202).json({ ok: true, replayed: true, jobId: job.id });
    } catch (error) {
      logger.error({ idempotencyKey, error: error.message }, '[webhook] failed to replay raw event');
      return res.status(500).json({ ok: false, error: 'failed to replay raw event' });
    }
  });

  return app;
}

async function startServer() {
  // Run database migrations before accepting connections
  try {
    await runMigrations();
    logger.info('[startup] Database migrations complete');
  } catch (migrationErr) {
    logger.error({ error: migrationErr.message }, '[startup] Database migrations failed — continuing');
  }

  // Verify database pool connectivity
  try {
    const dbHealth = await dbHealthCheck();
    if (dbHealth.healthy) {
      logger.info({ pool: getPoolMetrics() }, '[startup] Database pool ready');
    } else {
      logger.warn({ error: dbHealth.error }, '[startup] Database pool connectivity issue');
    }
  } catch (error) {
    logger.error({ error: error.message }, '[startup] Database health check failed');
  }

  validateRedisConfig();
  startConfigPoller();

  const port = process.env.PORT || 3000;
  const app = createApp();
  const server = app.listen(port, () => {
    logger.info({ port }, 'server listening');
  });

  return server;
}

module.exports = {
  createApp,
  startServer
};

if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
