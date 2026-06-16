const client = require('prom-client');

const register = new client.Registry();

client.collectDefaultMetrics({
  prefix: 'vero_',
  register,
});

const eventsProcessedTotal = new client.Counter({
  name: 'vero_events_processed_total',
  help: 'Total number of GitHub webhook events processed by the relayer.',
  labelNames: ['status', 'reason'],
  registers: [register],
});

const queueLatencySeconds = new client.Histogram({
  name: 'vero_queue_latency_seconds',
  help: 'Time spent processing relayer webhook events in seconds.',
  labelNames: ['status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

function recordEventProcessed(status, reason = 'none') {
  eventsProcessedTotal.inc({ status, reason });
}

function startQueueLatencyTimer() {
  return queueLatencySeconds.startTimer();
}

async function metricsHandler(req, res) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}

module.exports = {
  metricsHandler,
  recordEventProcessed,
  startQueueLatencyTimer,
};
