const express = require('express');
const rateLimit = require('express-rate-limit');
const { verifySignature } = require('./src/middleware/auth');
const { healthCheck } = require('./src/db/client');
const {
  buildGitHubPullRequestEventPayload,
  buildMetadataFromRequest,
  enqueueEvent,
  validateRedisConfig
} = require('./src/queue');
const { registerBatchOnChain } = require('./stellar');

// Inline require of the compiled/ts-node batcher. Using ts-node if available.
let EventBatcher;
try {
  require('ts-node/register');
  ({ EventBatcher } = require('./src/queue/batcher'));
} catch {
  // Minimal fallback batcher implementation.
  EventBatcher = class {
    constructor(flush) { this.flush = flush; this.queue = []; this.timer = null; }
    enqueue(id) {
      this.queue.push(id);
      if (!this.timer) this.timer = setTimeout(() => this._drain(), 5000);
      if (this.queue.length >= 50) this._drain();
    }
    _drain() {
      clearTimeout(this.timer);
      this.timer = null;
      if (!this.queue.length) return;
      const batch = this.queue.splice(0);
      this.flush(batch).catch(e => console.error('[batcher] flush error:', e));
    }
  };
}

function createApp(options = {}) {
  const enqueueEventJob = options.enqueueEventJob || enqueueEvent;
  const app = express();

  // Trust proxy for X-Forwarded-For support
  app.set('trust proxy', true);

  // Global rate limiter (100 req per 15 min)
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    message: 'Too many requests, please try again later.'
  });
  app.use(limiter);

  // JSON body parser with raw body capture
  app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; }
  }));

  // Health endpoint
  app.get('/health', (req, res) => res.status(200).send('OK'));

  // GitHub webhook endpoint
  app.post('/github-webhook', verifySignature, async (req, res) => {
    const { action, pull_request: pr } = req.body;
    if (action !== 'closed' || !pr?.merged) {
      return res.status(200).json({ skipped: true });
    }
    const hasLabel = pr.labels?.some(l => l.name === 'wave-contribution');
    if (!hasLabel) {
      return res.status(200).json({ skipped: true, reason: 'no wave-contribution label' });
    }
    const eventPayload = buildGitHubPullRequestEventPayload(req.body, buildMetadataFromRequest(req));
    try {
      const job = await enqueueEventJob(eventPayload);
      console.log(`[webhook] queued PR #${pr.number} eventType=${eventPayload.eventType} job=${job.id}`);
      return res.status(202).json({ ok: true, pr: pr.number, queued: true, jobId: job.id });
    } catch (error) {
      console.error(`[webhook] failed to enqueue PR #${pr.number}: ${error.message}`);
      return res.status(500).json({ ok: false, error: 'failed enqueue event' });
    }
  });

  // Initialize batcher (uses registerBatchOnChain from stellar)
  const batcher = new EventBatcher(registerBatchOnChain);
  // Note: batcher usage is elsewhere in the codebase.

  return app;
}

async function startServer() {
  validateRedisConfig();
  await healthCheck();
  const port = process.env.PORT || 3000;
  const app = createApp();
  return app.listen(port, () => console.log(`Server listening on port ${port}`));
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
