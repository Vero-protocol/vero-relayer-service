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
const { startConfigPoller, stopConfigPoller } = require('./src/services/config-poller');
const { ingestRateLimiter } = require('./src/middleware/rateLimit');
const { closeEventQueue } = require('./src/queue/event-queue');
const { closeDbPool } = require('./src/db/client');

async function closeShutdownResources(resources, shutdownLogger) {
  const results = await Promise.allSettled(
    resources.map(resource => Promise.resolve().then(() => resource.close()))
  );
  const failures = [];

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const resource = resources[index];
      const error = result.reason;
      const message = error && error.message ? error.message : String(error);
      failures.push(error);
      shutdownLogger.error({ resource: resource.name, error: message }, '[server] Shutdown resource cleanup failed');
    }
  });

  if (failures.length > 0) {
    throw new AggregateError(failures, 'shutdown resource cleanup failed');
  }
}

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
      logger.error({ pr: pr.number, error: error.message }, '[webhook] failed to enqueue PR');
      return res.status(500).json({ ok: false, error: 'failed to enqueue event' });
    }
  });

  return app;
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });

    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  });
}

function createGracefulShutdown(server, options = {}) {
  const shutdownLogger = options.logger || logger;
  const stopPoller = options.stopConfigPoller || stopConfigPoller;
  const closeQueue = options.closeEventQueue || closeEventQueue;
  const closePool = options.closeDbPool || closeDbPool;
  let shutdownPromise = null;

  return async function shutdown(signal = 'manual') {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      shutdownLogger.info({ signal }, '[server] Shutdown initiated');
      stopPoller();
      await closeHttpServer(server);
      await closeShutdownResources([
        { name: 'eventQueue', close: closeQueue },
        { name: 'dbPool', close: closePool }
      ], shutdownLogger);
      shutdownLogger.info({ signal }, '[server] Shutdown complete');
    })();

    return shutdownPromise;
  };
}

function registerShutdownSignals(shutdown, options = {}) {
  const shutdownLogger = options.logger || logger;
  const exit = options.exit || process.exit;

  function handleSignal(signal) {
    shutdown(signal)
      .then(() => exit(0))
      .catch(error => {
        shutdownLogger.error({ signal, error: error.message }, '[server] Shutdown failed');
        exit(1);
      });
  }

  const handleSigterm = () => handleSignal('SIGTERM');
  const handleSigint = () => handleSignal('SIGINT');

  process.once('SIGTERM', handleSigterm);
  process.once('SIGINT', handleSigint);

  return function removeShutdownSignals() {
    process.removeListener('SIGTERM', handleSigterm);
    process.removeListener('SIGINT', handleSigint);
  };
}

async function startServer(options = {}) {
  const env = options.env || process.env;
  const appLogger = options.logger || logger;
  const validateQueueConfig = options.validateRedisConfig || validateRedisConfig;
  const startPoller = options.startConfigPoller || startConfigPoller;

  validateQueueConfig(env);
  startPoller();

  const port = options.port !== undefined ? options.port : (env.PORT || 3000);
  const app = options.app || createApp(options.appOptions);
  const server = app.listen(port, () => {
    appLogger.info({ port }, 'server listening');
  });

  const shutdown = createGracefulShutdown(server, {
    logger: appLogger,
    stopConfigPoller: options.stopConfigPoller,
    closeEventQueue: options.closeEventQueue,
    closeDbPool: options.closeDbPool
  });

  server.shutdown = shutdown;
  if (options.handleSignals !== false) {
    server.removeShutdownHandlers = registerShutdownSignals(shutdown, {
      logger: appLogger,
      exit: options.exit
    });
  }

  return server;
}

module.exports = {
  closeHttpServer,
  closeShutdownResources,
  createApp,
  createGracefulShutdown,
  registerShutdownSignals,
  startServer
};

if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
