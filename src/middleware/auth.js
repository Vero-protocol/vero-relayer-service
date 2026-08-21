const crypto = require('crypto');
const { logger } = require('../logger');

// Authentication decisions are host-owned state. Keeping them in a WeakMap
// prevents request headers or body fields from impersonating a verified result,
// while allowing the entry to be garbage-collected with the request.
const signatureDecisions = new WeakMap();

const SIGNATURE_STATUS = Object.freeze({
  VERIFIED: 'verified',
  INVALID: 'invalid',
  MISSING: 'missing',
  SECRET_MISSING: 'secret-missing',
  UNSIGNED_ALLOWED: 'unsigned-allowed',
});

function requestPayload(req) {
  if (Buffer.isBuffer(req.rawBody)) {
    return req.rawBody;
  }

  return Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
}

/**
 * Evaluate and cache the GitHub HMAC decision for one request.
 *
 * The rate limiter and the enforcing middleware deliberately share this
 * result, so an authentication-looking header never carries authority by
 * itself and the HMAC is not calculated twice.
 */
function getSignatureDecision(req) {
  const cached = signatureDecisions.get(req);
  if (cached) return cached;

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  let decision;

  if (!secret) {
    decision = {
      status: process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true'
        ? SIGNATURE_STATUS.UNSIGNED_ALLOWED
        : SIGNATURE_STATUS.SECRET_MISSING,
      verified: false,
    };
  } else {
    const signature = req.headers?.['x-hub-signature-256'];

    if (typeof signature !== 'string' || signature.length === 0) {
      decision = { status: SIGNATURE_STATUS.MISSING, verified: false };
    } else {
      const digest = Buffer.from(
        'sha256=' + crypto.createHmac('sha256', secret).update(requestPayload(req)).digest('hex'),
        'utf8'
      );
      const supplied = Buffer.from(signature, 'utf8');
      const verified = supplied.length === digest.length && crypto.timingSafeEqual(supplied, digest);

      decision = {
        status: verified ? SIGNATURE_STATUS.VERIFIED : SIGNATURE_STATUS.INVALID,
        verified,
      };
    }
  }

  const immutableDecision = Object.freeze(decision);
  signatureDecisions.set(req, immutableDecision);
  return immutableDecision;
}

/**
 * Populate the private authentication decision before rate-limit tier
 * selection. Invalid requests continue so they can consume the public quota;
 * verifySignature remains responsible for the eventual HTTP rejection.
 */
function classifySignature(req, _res, next) {
  getSignatureDecision(req);
  return next();
}

function isSignatureVerified(req) {
  return signatureDecisions.get(req)?.verified === true;
}

function verifySignature(req, res, next) {
  const decision = getSignatureDecision(req);

  if (decision.status === SIGNATURE_STATUS.UNSIGNED_ALLOWED) {
    (req.log || logger).warn(
      '[webhook-auth] SECURITY WARNING: accepting an unsigned GitHub webhook because ALLOW_UNSIGNED_WEBHOOKS=true'
    );
    return next();
  }

  if (decision.status === SIGNATURE_STATUS.SECRET_MISSING) {
    return res.status(500).json({ error: 'Webhook secret is not configured' });
  }

  if (decision.status === SIGNATURE_STATUS.MISSING) {
    return res.status(401).json({ error: 'Missing x-hub-signature-256 header' });
  }

  if (!decision.verified) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  return next();
}

module.exports = {
  classifySignature,
  isSignatureVerified,
  verifySignature,
};
