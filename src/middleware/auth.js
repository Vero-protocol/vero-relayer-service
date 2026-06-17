const crypto = require('crypto');

function verifySignature(req, res, next) {
  const signature = req.headers['x-vero-signature'];
  const secret = process.env.WEBHOOK_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV !== 'production') {
      return next();
    }
    return res.status(500).json({ error: 'Webhook secret is not configured' });
  }

  if (!signature) {
    if (process.env.NODE_ENV !== 'production') {
      return next();
    }
    return res.status(401).json({ error: 'Missing X-Vero-Signature header' });
  }

  const payload = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
  const hmac = crypto.createHmac('sha256', secret);
  const digest = hmac.update(payload).digest('hex');

  let providedSignature = signature;
  if (providedSignature.startsWith('sha256=')) {
    providedSignature = providedSignature.slice(7);
  }

  if (providedSignature.length !== digest.length) {
    return res.status(401).json({ error: 'Invalid signature length' });
  }

  try {
    if (!crypto.timingSafeEqual(Buffer.from(providedSignature), Buffer.from(digest))) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch (err) {
    return res.status(401).json({ error: 'Invalid signature format' });
  }

  next();
}

module.exports = { verifySignature };
