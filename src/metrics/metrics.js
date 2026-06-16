const client = require('prom-client');

// Collect default metrics (process, memory, etc.)
client.collectDefaultMetrics();

// Counter for total processed events
const vero_events_processed_total = new client.Counter({
  name: 'vero_events_processed_total',
  help: 'Total number of processed Vero events',
  labelNames: ['task_type'],
});

// Histogram for queue latency (seconds)
const queue_latency_seconds = new client.Histogram({
  name: 'queue_latency_seconds',
  help: 'Queue latency in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10],
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
};
