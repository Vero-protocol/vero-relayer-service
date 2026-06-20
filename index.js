const express = require('express');
const { verifySignature } = require('./src/middleware/auth');
const {
  buildGitHubPullRequestEventPayload,
  buildMetadataFromRequest,
  enqueueEvent,
  validateRedisConfig
} = require('./src/queue');
const { registerMetrics } = require('./src/metrics/metrics');
const { logger } = require('./src/logger');
const { startConfigPoller } = require('./src/services/config-poller');
const { getHttpStatusForError, getSafeErrorMetadata } = require('./src/services/stellar-errors');
const { ingestRateLimiter } = require('./src/middleware/rateLimit');

function createApp(options = {}) {
  const enqueueEventJob = options.enqueueEventJob || enqueueEvent;
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

  app.get('/health', (req, res) => {
    res.status(200).send('OK');
  });

  // GitHub webhook endpoint — rate-limited before signature verification
  app.post('/github-webhook', ingestRateLimiter, verifySignature, async (req, res) => {
    const { action, pull_request: pr } = req.body;
    if (action !== 'closed' || !pr?.merged) {
      return res.status(200).json({ skipped: true });
    }

    const hasLabel = pr.labels?.some(label => label.name === 'wave-contribution');
    if (!hasLabel) {
      return res.status(200).json({ skipped: true, reason: 'no wave-contribution label' });
    }
    const eventPayload = buildGitHubPullRequestEventPayload(req.body, buildMetadataFromRequest(req));
    try {
      const job = await enqueueEventJob(eventPayload);
      logger.info({ pr: pr.number, eventType: eventPayload.eventType, jobId: job.id }, '[webhook] queued PR event');
      return res.status(202).json({ ok: true, pr: pr.number, queued: true, jobId: job.id });
    } catch (error) {
      const statusCode = getHttpStatusForError(error);
      logger.error({ pr: pr.number, ...getSafeErrorMetadata(error), statusCode }, '[webhook] failed to enqueue PR');
      return res.status(statusCode).json({
        ok: false,
        error: statusCode === 503 ? 'service unavailable' : 'failed to enqueue event'
      });
    }
  });

  return app;
}

async function startServer() {
  validateRedisConfig();
  startConfigPoller();

  const port = process.env.PORT || 3000;
  const app = createApp();
  const server = app.listen(port, () => {
    logger.info({ port }, 'server listening');
  });

  return app.listen(port, () => logger.info({ port }, 'Server listening on port'));
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
