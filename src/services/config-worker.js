const { parentPort, workerData } = require('worker_threads');
const Redis = require('ioredis');
const crypto = require('crypto');

const CONFIG_SIGNATURE_KEY = 'vero:config:signature';
const CONFIG_PAYLOAD_KEY = 'vero:config:payload';

let redisClient = null;

// ---------------------------------------------------------------------------
// Inline JWT verification — mirrors jwt.js but runs in the worker thread
// without importing from the main thread module graph (worker threads do not
// share module instances). Uses the same HS256/HMAC-SHA256 algorithm.
// ---------------------------------------------------------------------------
function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const rem = padded.length % 4;
  const padded2 = rem ? padded + '='.repeat(4 - rem) : padded;
  return Buffer.from(padded2, 'base64').toString('utf8');
}

/**
 * Verify a config JWT signature and confirm its embedded payload matches the
 * provided raw payload string.
 *
 * Returns the decoded claims on success; throws a descriptive Error on failure.
 *
 * @param {string} token   - JWT from vero:config:signature
 * @param {string} payload - Raw string from vero:config:payload
 * @returns {{ payload: string, iss: string, exp: number, iat: number }}
 */
function verifyConfigSignatureInWorker(token, payload) {
  const secret = workerData.jwtSigningSecret;

  if (!secret || secret.trim().length < 32) {
    throw new Error('JWT_SIGNING_SECRET not available in worker or too short');
  }

  if (!token || typeof token !== 'string') {
    throw new Error('Signature token is missing');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT signature token');
  }

  const [rawHeader, rawClaims, rawSignature] = parts;

  // 1. Verify algorithm
  let header;
  try {
    header = JSON.parse(base64urlDecode(rawHeader));
  } catch {
    throw new Error('Invalid JWT header in signature token');
  }

  if (header.alg !== 'HS256') {
    throw new Error(`Unsupported algorithm: ${header.alg}`);
  }

  // 2. Timing-safe signature check
  const signingInput = `${rawHeader}.${rawClaims}`;
  const expectedSig = base64url(
    crypto.createHmac('sha256', secret).update(signingInput).digest()
  );

  let valid = false;
  try {
    valid = crypto.timingSafeEqual(
      Buffer.from(rawSignature),
      Buffer.from(expectedSig)
    );
  } catch {
    throw new Error('Signature length mismatch — invalid token');
  }

  if (!valid) {
    throw new Error('Invalid JWT signature');
  }

  // 3. Decode and validate claims
  let claims;
  try {
    claims = JSON.parse(base64urlDecode(rawClaims));
  } catch {
    throw new Error('Invalid JWT claims in signature token');
  }

  const now = Math.floor(Date.now() / 1000);

  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    throw new Error('Config signature token has expired');
  }

  if (typeof claims.iat !== 'number' || claims.iat > now) {
    throw new Error('Config signature token issued in the future');
  }

  const expectedIssuer = workerData.jwtIssuer || 'vero-relayer-service';
  if (claims.iss !== expectedIssuer) {
    throw new Error(`Invalid issuer: expected "${expectedIssuer}", got "${claims.iss}"`);
  }

  // 3b. Audience scoping — mirrors jwt.js. A token minted for service auth
  // (/metrics, /internal/webhooks/replay) must not double as a config
  // signature: CONFIG_ALLOWLIST includes STELLAR_HORIZON_URLS and
  // STELLAR_RPC_URLS, and this process holds STELLAR_SECRET_KEY.
  const CONFIG_AUDIENCE = 'vero-config-sync';
  const aud = claims.aud;
  const audMatches = Array.isArray(aud)
    ? aud.includes(CONFIG_AUDIENCE)
    : aud === CONFIG_AUDIENCE;
  if (!audMatches) {
    throw new Error(
      `Invalid audience: expected "${CONFIG_AUDIENCE}", got ${
        aud === undefined ? 'none' : `"${aud}"`
      }`
    );
  }

  // 4. Confirm the signed payload claim matches the actual Redis payload
  if (claims.payload !== payload) {
    throw new Error('Config payload does not match signed payload claim');
  }

  return claims;
}

async function pollConfig() {
  try {
    if (!redisClient) {
      redisClient = new Redis(workerData.redisOpts);

      redisClient.on('error', (err) => {
        parentPort.postMessage({
          type: 'error',
          error: err.message
        });
      });
    }

    // --- Signed path ---
    const signature = await redisClient.get(CONFIG_SIGNATURE_KEY);
    const payload = await redisClient.get(CONFIG_PAYLOAD_KEY);

    if (signature && payload) {
      // Only label as 'signed' after real cryptographic verification.
      try {
        verifyConfigSignatureInWorker(signature, payload);
        // Include rawSignature + rawPayload so the main thread can perform
        // its own independent re-verification (defense in depth).
        parentPort.postMessage({
          type: 'configUpdate',
          configs: JSON.parse(payload),
          source: 'signed',
          rawSignature: signature,
          rawPayload: payload,
        });
        return;
      } catch (verifyErr) {
        parentPort.postMessage({
          type: 'error',
          error: `Config signature verification failed in worker: ${verifyErr.message}`
        });
        // Fall through to unsigned path — poller will apply allowlist filtering.
      }
    }

    // --- Unsigned fallback path ---
    // Only active when the operator has explicitly opted in via CONFIG_SYNC_ALLOW_UNSIGNED.
    if (!workerData.allowUnsigned) {
      return;
    }

    const configs = await redisClient.hgetall('vero:config');
    if (configs && Object.keys(configs).length > 0) {
      parentPort.postMessage({
        type: 'configUpdate',
        configs,
        source: 'unsigned'
      });
    }
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      error: error.message
    });
  }
}

// Start polling loop
async function startPolling() {
  await pollConfig();

  const interval = setInterval(() => {
    pollConfig().catch(err =>
      parentPort.postMessage({
        type: 'error',
        error: err.message
      })
    );
  }, workerData.intervalMs);

  // Unref to allow clean exit
  if (typeof interval.unref === 'function') {
    interval.unref();
  }
}

startPolling().catch(err => {
  parentPort.postMessage({
    type: 'error',
    error: err.message
  });
  process.exit(1);
});
