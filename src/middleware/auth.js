const crypto = require('crypto');

function verifySignature(req, res, next) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV !== 'production') return next();
    return res.status(500).json({ error: 'Webhook secret is not configured' });
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    return res.status(401).json({ error: 'Missing x-hub-signature-256 header' });
  }

  const payload = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
  const digest = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');

  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  req.authenticated = true;
  next();
}

module.exports = { verifySignature };
