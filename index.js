const express = require('express');
const { registerTaskOnChain } = require('./stellar');
const { verifySignature } = require('./src/middleware/auth');

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.post('/github-webhook', verifySignature, async (req, res) => {
  const { action, pull_request: pr } = req.body;

  if (action !== 'closed' || !pr?.merged) {
    return res.status(200).json({ skipped: true });
  }

  const hasLabel = pr.labels?.some(l => l.name === 'wave-contribution');
  if (!hasLabel) {
    return res.status(200).json({ skipped: true, reason: 'no wave-contribution label' });
  }

  const start = Date.now();
  console.log(`[webhook] PR #${pr.number} merged with wave-contribution label`);
  try {
    await registerTaskOnChain(pr.number);
    vero_events_processed_total.inc();
  } catch (error) {
    // We can increment an error counter or track failure if needed, but currently let's just rethrow or return 500.
    // The problem statement requires tracking processed events and latency.
    throw error;
  } finally {
    const durationSec = (Date.now() - start) / 1000;
    queue_latency_seconds.observe(durationSec);
  }
  res.status(200).json({ ok: true, pr: pr.number });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

module.exports = app;
