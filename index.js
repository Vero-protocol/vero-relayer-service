const express = require('express');
const { registerTaskOnChain } = require('./stellar');
const {
  metricsHandler,
  recordEventProcessed,
  startQueueLatencyTimer,
} = require('./src/metrics');

const app = express();
app.use(express.json());

app.get('/metrics', metricsHandler);

app.post('/github-webhook', async (req, res) => {
  const stopLatencyTimer = startQueueLatencyTimer();
  const { action, pull_request: pr } = req.body;

  if (action !== 'closed' || !pr?.merged) {
    recordEventProcessed('skipped', 'not_merged');
    stopLatencyTimer({ status: 'skipped' });
    return res.status(200).json({ skipped: true });
  }

  const hasLabel = pr.labels?.some(l => l.name === 'wave-contribution');
  if (!hasLabel) {
    recordEventProcessed('skipped', 'missing_label');
    stopLatencyTimer({ status: 'skipped' });
    return res.status(200).json({ skipped: true, reason: 'no wave-contribution label' });
  }

  console.log(`[webhook] PR #${pr.number} merged with wave-contribution label`);
  try {
    await registerTaskOnChain(pr.number);
    recordEventProcessed('processed');
    stopLatencyTimer({ status: 'processed' });
    res.status(200).json({ ok: true, pr: pr.number });
  } catch (error) {
    recordEventProcessed('error', 'registration_failed');
    stopLatencyTimer({ status: 'error' });
    console.error('[webhook] Failed to register PR on-chain', error);
    res.status(500).json({ ok: false, error: 'registration_failed' });
  }
});

app.listen(3000, () => console.log('Server listening on port 3000'));
