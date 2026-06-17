const express = require('express');
const {
  buildGitHubPullRequestEventPayload,
  buildMetadataFromRequest,
  enqueueEvent,
  validateRedisConfig
} = require('./src/queue');
const { verifySignature } = require('./src/middleware/auth');
const { registerMetrics } = require('./src/metrics/metrics');
const { logger } = require('./src/logger');
const { startConfigPoller } = require('./src/services/config-poller');

function createApp(options = {}) {
  const enqueueEventJob = options.enqueueEventJob || enqueueEvent;
  const app = express();

  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  registerMetrics(app);

  app.get('/health', (req, res) => {
    res.status(200).send('OK');
  });

  app.post('/github-webhook', verifySignature, async (req, res) => {
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
      logger.error({ pr: pr.number, error: error.message }, '[webhook] failed to enqueue PR');
      return res.status(500).json({ ok: false, error: 'failed to enqueue event' });
    }
  });

  return app;
}

function startServer() {
  validateRedisConfig();
  startConfigPoller();

  const port = process.env.PORT || 3000;
  const app = createApp();
  const server = app.listen(port, () => {
    logger.info({ port }, 'server listening');
  });

  return app.listen(port, () => logger.info({ port }, 'Server listening on port'));
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer
};
