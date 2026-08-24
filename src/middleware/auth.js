const crypto = require('crypto');
const { logger } = require('../logger');

function verifySignature(req, res, next) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    if (process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true') {
      (req.log || logger).warn(
        '[webhook-auth] SECURITY WARNING: accepting an unsigned GitHub webhook because ALLOW_UNSIGNED_WEBHOOKS=true'
      );
      return next();
    }
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

  next();
}

module.exports = { verifySignature };
