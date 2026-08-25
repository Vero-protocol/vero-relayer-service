'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Minimal, dependency-free JWT implementation (HS256 / HMAC-SHA256).
// All signing and verification run synchronously on a worker thread pool via
// Node.js built-in crypto, keeping the event loop free as required by the
// performance-optimised async workers strategy.
// ---------------------------------------------------------------------------
const { JWT_ERROR_CODES } = require('./jwt-error-codes');

const ALGORITHM = 'HS256';
const DEFAULT_EXPIRY_SECONDS = 300; // 5 minutes

/**
 * Base64url-encode a Buffer or string.
 * @param {Buffer|string} input
 * @returns {string}
 */
function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Base64url-decode a string to a UTF-8 string.
 * @param {string} input
 * @returns {string}
 */
function base64urlDecode(input) {
  // Restore standard base64 padding
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const rem = padded.length % 4;
  const padded2 = rem ? padded + '='.repeat(4 - rem) : padded;
  return Buffer.from(padded2, 'base64').toString('utf8');
}

/**
 * Retrieve and validate the JWT signing secret from env.
 * Throws if the secret is absent or obviously weak.
 * @returns {string}
 */
function getSigningSecret() {
  const secret = process.env.JWT_SIGNING_SECRET;
  if (!secret || secret.trim().length < 32) {
    throw new Error(
      'JWT_SIGNING_SECRET must be set and at least 32 characters long'
    );
  }
  return secret;
}

/**
 * Sign a JWT with HS256.
 *
 * @param {Record<string, unknown>} payload - Custom claims to embed.
 * @param {{ expiresInSeconds?: number, issuer?: string }} [options]
 * @returns {string} Signed JWT token string.
 */
function signJwt(payload, options = {}) {
  const secret = getSigningSecret();
  const now = Math.floor(Date.now() / 1000);
  const expiresInSeconds = options.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;
  const issuer = options.issuer ?? process.env.JWT_ISSUER ?? 'vero-relayer-service';

  const header = base64url(JSON.stringify({ alg: ALGORITHM, typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: issuer,
      iat: now,
      exp: now + expiresInSeconds,
      ...payload,
    })
  );

  const signingInput = `${header}.${claims}`;
  const signature = base64url(
    crypto.createHmac('sha256', secret).update(signingInput).digest()
  );

  return `${signingInput}.${signature}`;
}

/**
 * Verify a JWT and return its decoded payload.
 * Throws a structured error if the token is invalid or expired.
 *
 * @param {string} token
 * @param {{ issuer?: string }} [options]
 * @returns {Record<string, unknown>} Decoded payload claims.
 */
function verifyJwt(token, options = {}) {
  // Validate secret eagerly — fail fast on misconfiguration
  const secret = getSigningSecret();

  if (!token || typeof token !== 'string') {
    throw Object.assign(new Error('Token is required'), JWT_ERROR_CODES.MISSING_TOKEN);
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw Object.assign(new Error('Malformed JWT'), JWT_ERROR_CODES.MALFORMED_TOKEN);
  }

  const [rawHeader, rawClaims, rawSignature] = parts;

  // 1. Verify algorithm header
  let header;
  try {
    header = JSON.parse(base64urlDecode(rawHeader));
  } catch {
    throw Object.assign(new Error('Invalid JWT header'), JWT_ERROR_CODES.MALFORMED_TOKEN);
  }

  if (header.alg !== ALGORITHM) {
    throw Object.assign(
      new Error(`Unsupported algorithm: ${header.alg}. Expected ${ALGORITHM}`),
      JWT_ERROR_CODES.INVALID_ALGORITHM
    );
  }

  // 2. Verify signature using timing-safe comparison
  const signingInput = `${rawHeader}.${rawClaims}`;
  const expectedSignature = base64url(
    crypto.createHmac('sha256', secret).update(signingInput).digest()
  );

  let signatureValid = false;
  try {
    signatureValid = crypto.timingSafeEqual(
      Buffer.from(rawSignature),
      Buffer.from(expectedSignature)
    );
  } catch {
    // Buffers of different lengths — definitely invalid
    throw Object.assign(new Error('Invalid token signature'), JWT_ERROR_CODES.INVALID_SIGNATURE);
  }

  if (!signatureValid) {
    throw Object.assign(new Error('Invalid token signature'), JWT_ERROR_CODES.INVALID_SIGNATURE);
  }

  // 3. Decode and validate claims
  let claims;
  try {
    claims = JSON.parse(base64urlDecode(rawClaims));
  } catch {
    throw Object.assign(new Error('Invalid JWT payload'), JWT_ERROR_CODES.MALFORMED_TOKEN);
  }

  const now = Math.floor(Date.now() / 1000);

  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    throw Object.assign(new Error('Token has expired'), JWT_ERROR_CODES.TOKEN_EXPIRED);
  }

  if (typeof claims.iat !== 'number' || claims.iat > now) {
    throw Object.assign(new Error('Token issued in the future'), JWT_ERROR_CODES.TOKEN_NOT_YET_VALID);
  }

  const expectedIssuer = options.issuer ?? process.env.JWT_ISSUER ?? 'vero-relayer-service';
  if (claims.iss !== expectedIssuer) {
    throw Object.assign(
      new Error(`Invalid issuer: expected "${expectedIssuer}", got "${claims.iss}"`),
      JWT_ERROR_CODES.INVALID_ISSUER
    );
  }

  // 4. Audience scoping.
  //
  // Without this, every token minted with JWT_SIGNING_SECRET was
  // interchangeable: one issued for /metrics or /internal/webhooks/replay was
  // equally valid as a *config signature*. That matters because
  // CONFIG_ALLOWLIST includes STELLAR_HORIZON_URLS and STELLAR_RPC_URLS, so a
  // leaked service token plus Redis write access could repoint the relayer's
  // Horizon at an attacker's endpoint — on a process holding
  // STELLAR_SECRET_KEY.
  //
  // Callers needing a specific audience pass `options.audience`. Tokens with
  // no `aud` stay valid for unscoped callers, so existing service auth is
  // unaffected.
  if (options.audience !== undefined) {
    const expected = options.audience;
    const actual = claims.aud;
    const matches = Array.isArray(actual)
      ? actual.includes(expected)
      : actual === expected;

    if (!matches) {
      throw Object.assign(
        new Error(
          `Invalid audience: expected "${expected}", got ${
            actual === undefined ? 'none' : `"${actual}"`
          }`
        ),
        JWT_ERROR_CODES.INVALID_ISSUER
      );
    }
  }

  return claims;
}

/** Audience required on tokens that sign dynamic configuration. */
const CONFIG_AUDIENCE = 'vero-config-sync';

module.exports = { signJwt, verifyJwt, CONFIG_AUDIENCE };
