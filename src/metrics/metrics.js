let client;
try {
  client = require('prom-client');
} catch (e) {
  // provide a lightweight stub so code can run in environments without prom-client
  client = {
    register: {
      metrics: async () => '',
      contentType: 'text/plain',
      getSingleMetric: () => undefined,
    },
    collectDefaultMetrics: () => {},
    Counter: class {
      constructor() {}
      inc() {}
    },
    Histogram: class {
      constructor() {}
      observe() {}
    }
  };
}

// Collect default metrics (process, memory, etc.).
// Guard against duplicate collection when the module is imported multiple times
try {
  if (!client.register.getSingleMetric || !client.register.getSingleMetric('process_cpu_user_seconds_total')) {
    client.collectDefaultMetrics();
  }
} catch (e) {
  console.warn('prom-client: failed to collect default metrics:', e && e.message);
}

// Counter for total processed events, labeled by task_type for better granularity
const vero_events_processed_total = client.register.getSingleMetric('vero_events_processed_total') || new client.Counter({
  name: 'vero_events_processed_total',
  help: 'Total number of processed Vero events',
  labelNames: ['task_type'],
});

// Histogram for queue latency (seconds)
const queue_latency_seconds = client.register.getSingleMetric('queue_latency_seconds') || new client.Histogram({
  name: 'queue_latency_seconds',
  help: 'Queue latency in seconds',
  labelNames: ['task_type'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

// Counter for rate limit hits, labeled by limiter type and route
const rate_limit_hits_total = client.register.getSingleMetric('rate_limit_hits_total') || new client.Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of HTTP requests rejected due to rate limiting',
  labelNames: ['limiter_type', 'route'],
});

/**
 * Register the /metrics endpoint on the given Express app.
 * @param {import('express').Express} app
 */
function registerMetrics(app) {
  app.get('/metrics', async (req, res) => {
    try {
      const metrics = await client.register.metrics();
      res.set('Content-Type', client.register.contentType);
      res.end(metrics);
    } catch (err) {
      res.status(500).end(err.toString());
    }
  });
}

module.exports = {
  registerMetrics,
  vero_events_processed_total,
  queue_latency_seconds,
  rate_limit_hits_total,
};
