const Redis = require('ioredis');
const { getRedisConnectionOptions } = require('../queue/redis');
const { logger } = require('../logger');
const { verifyJwt, CONFIG_AUDIENCE } = require('./jwt');
const { Worker } = require('worker_threads');
const path = require('path');

let pollerInterval = null;
let redisClient = null;
let configWorker = null;

// Dynamic config cache
const dynamicConfig = {};

// Config signature verification
const CONFIG_SIGNATURE_KEY = 'vero:config:signature';
const CONFIG_PAYLOAD_KEY = 'vero:config:payload';

// ---------------------------------------------------------------------------
// Allowlist — the ONLY keys that may be changed via dynamic config sync.
//
// Inclusion criteria: keys that operators legitimately need to tune at runtime
// (fees, log verbosity, rate limits, cache TTLs, network selection).
//
// Excluded (blocked regardless of signature validity):
//   - STELLAR_SECRET_KEY      — private key; compromise = funds drained
//   - DATABASE_URL / PG*      — DB credentials; could redirect to attacker DB
//   - JWT_SIGNING_SECRET      — auth signing key; compromise = token forgery
//   - REDIS_PASSWORD          — broker credential
//   - GITHUB_WEBHOOK_SECRET   — HMAC secret for webhook verification
//   - PGPASSWORD              — DB credential alias
//   - Any key not explicitly listed below
// ---------------------------------------------------------------------------
const CONFIG_ALLOWLIST = new Set([
  'STELLAR_BASE_FEE',
  'STELLAR_MAX_FEE',
  'STELLAR_NETWORK',
  'STELLAR_HORIZON_URLS',
  'STELLAR_RPC_URLS',
  'LOG_LEVEL',
  'RPC_CACHE_TTL_FEE',
  'CONFIG_SYNC_INTERVAL_MS',
  'EVENT_QUEUE_CONCURRENCY',
  'EVENT_QUEUE_RETRY_ATTEMPTS',
  'EVENT_QUEUE_RETRY_BACKOFF_DELAY',
  'EVENT_PAYLOAD_RETENTION_DAYS',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_PUBLIC_MAX',
  'RATE_LIMIT_AUTH_MAX',
  'OTEL_SERVICE_NAME',
  'OTEL_SDK_DISABLED',
]);

function verifyConfigSignature(payload, signature) {
  try {
    // Scoped audience: a token minted for service auth (/metrics, replay) must
    // not double as a config signature. CONFIG_ALLOWLIST includes the Horizon
    // and RPC endpoint lists, and this process holds STELLAR_SECRET_KEY.
    const decoded = verifyJwt(signature, { audience: CONFIG_AUDIENCE });

    // Verify the payload matches the signed content
    if (decoded.payload !== payload) {
      throw new Error('Config payload does not match signature');
    }

    logger.info({ issuer: decoded.iss }, '[config-poller] Config signature verified');
    return true;
  } catch (error) {
    logger.warn({ error: error.message }, '[config-poller] Config signature verification failed');
    return false;
  }
}

async function pollConfig() {
  try {
    if (!redisClient) {
      const redisOpts = getRedisConnectionOptions();
      redisClient = new Redis(redisOpts);

      // Handle connection errors gracefully without crashing the app
      redisClient.on('error', (err) => {
        logger.warn({ error: err.message }, '[config-poller] Redis client connection error');
      });
    }

    // Check for signed config first (security requirement)
    const signature = await redisClient.get(CONFIG_SIGNATURE_KEY);
    const payload = await redisClient.get(CONFIG_PAYLOAD_KEY);

    if (signature && payload) {
      if (verifyConfigSignature(payload, signature)) {
        const configs = JSON.parse(payload);
        await applyConfig(configs, 'signed');
        return;
      } else {
        logger.warn('[config-poller] Signed config verification failed, skipping signed config');
      }
    }

    // Unsigned fallback — only active when explicitly opted-in by the operator.
    // Keys are still filtered through the allowlist even in this path.
    if (process.env.CONFIG_SYNC_ALLOW_UNSIGNED !== 'true') {
      return;
    }

    const configs = await redisClient.hgetall('vero:config');
    if (configs && Object.keys(configs).length > 0) {
      await applyConfig(configs, 'unsigned');
    }
  } catch (error) {
    logger.warn({ error: error.message }, '[config-poller] Failed to poll config from Redis, using existing env');
  }
}

/**
 * Apply a config object to process.env, enforcing the allowlist.
 *
 * Sensitive keys (credentials, signing secrets, etc.) are always rejected,
 * even when the payload has a valid signature.  Any key not on the allowlist
 * is silently dropped and a warning is emitted so operators know.
 *
 * @param {Record<string, string>} configs - Key/value pairs to apply.
 * @param {string} source - 'signed' | 'unsigned' — for audit logging only.
 */
async function applyConfig(configs, source) {
  const allowed = [];
  const rejected = [];

  for (const key of Object.keys(configs)) {
    if (CONFIG_ALLOWLIST.has(key)) {
      allowed.push(key);
    } else {
      rejected.push(key);
    }
  }

  if (rejected.length > 0) {
    logger.warn(
      { rejectedKeys: rejected, source },
      '[config-poller] Blocked attempt to set non-allowlisted config keys via dynamic sync'
    );
  }

  if (allowed.length === 0) {
    return;
  }

  logger.info({ keys: allowed, source }, '[config-poller] Applying dynamic config');

  for (const key of allowed) {
    const value = configs[key];
    if (value !== undefined && value !== null) {
      process.env[key] = value;
      dynamicConfig[key] = value;
    }
  }

  // Special handling for LOG_LEVEL
  if (CONFIG_ALLOWLIST.has('LOG_LEVEL') && configs.LOG_LEVEL) {
    logger.level = configs.LOG_LEVEL;
  }

  // Clear fee engine cache when config changes to ensure new values are used
  const { clearFeeEstimateCache } = require('./fee-engine');
  clearFeeEstimateCache();

  // If any of the three network/endpoint keys changed, flush the rpc-factory
  // instance cache so the next getHorizonServer()/getSorobanServer() call
  // picks up the new values rather than the stale pre-change snapshots.
  // This eliminates the passphrase/endpoint divergence described in the
  // network/passphrase bug: stellar.js re-reads STELLAR_NETWORK per call,
  // so without this flush the factory would still point at the old network.
  const RPC_ENDPOINT_KEYS = ['STELLAR_NETWORK', 'STELLAR_HORIZON_URLS', 'STELLAR_RPC_URLS'];
  const endpointChanged = allowed.some(k => RPC_ENDPOINT_KEYS.includes(k));
  if (endpointChanged) {
    const rpcFactory = require('./rpc-factory');
    rpcFactory.invalidateCache();
    logger.info(
      { changedKeys: allowed.filter(k => RPC_ENDPOINT_KEYS.includes(k)) },
      '[config-poller] RPC factory cache invalidated after endpoint/network config change'
    );
  }
}

function startConfigPoller() {
  if (pollerInterval) return;

  const intervalMs = Number(process.env.CONFIG_SYNC_INTERVAL_MS) || 5000;
  const useAsyncWorker = process.env.CONFIG_ASYNC_WORKER === 'true';

  if (useAsyncWorker) {
    // Use async worker for performance optimization
    startConfigWorker();
  } else {
    // Use direct polling (default for backward compatibility)
    pollConfig().then(() => {
      pollerInterval = setInterval(pollConfig, intervalMs);
      if (pollerInterval && typeof pollerInterval.unref === 'function') {
        pollerInterval.unref();
      }
    });
  }
}

function startConfigWorker() {
  if (configWorker) return;

  const workerPath = path.join(__dirname, 'config-worker.js');
  configWorker = new Worker(workerPath, {
    workerData: {
      intervalMs: Number(process.env.CONFIG_SYNC_INTERVAL_MS) || 5000,
      redisOpts: getRedisConnectionOptions(),
      // Pass signing material so the worker can verify independently.
      // These are read from process.env here (in the main thread) and
      // embedded in workerData — they are never readable from Redis.
      jwtSigningSecret: process.env.JWT_SIGNING_SECRET,
      jwtIssuer: process.env.JWT_ISSUER || 'vero-relayer-service',
      allowUnsigned: process.env.CONFIG_SYNC_ALLOW_UNSIGNED === 'true',
    }
  });

  configWorker.on('message', (message) => {
    if (message.type === 'configUpdate') {
      // Defense in depth: never trust message.source from the worker at face
      // value.  Re-verify the signature here in the main thread before
      // applying any config that claims to be 'signed'.
      handleWorkerConfigUpdate(message).catch(err => {
        logger.error({ error: err.message }, '[config-poller] Failed to apply worker config');
      });
    } else if (message.type === 'error') {
      logger.warn({ error: message.error }, '[config-poller] Worker reported error');
    }
  });

  configWorker.on('error', (err) => {
    logger.error({ error: err.message }, '[config-poller] Config worker error');
  });

  configWorker.on('exit', (code) => {
    if (code !== 0) {
      logger.warn({ code }, '[config-poller] Config worker exited unexpectedly');
      configWorker = null;
    }
  });

  logger.info('[config-poller] Started async config worker');
}

/**
 * Handle a configUpdate message from the async worker.
 *
 * The worker already performed its own signature check before setting
 * source:'signed', but we re-verify here in the main thread as a second
 * layer of defense.  If the worker sends source:'signed' but we cannot
 * confirm it, the message is rejected outright.
 *
 * @param {{ configs: object, source: string, signature?: string, payload?: string }} message
 */
async function handleWorkerConfigUpdate(message) {
  const { configs, source } = message;

  if (source === 'signed') {
    // The worker must include the raw signature + payload so we can re-verify.
    // If it doesn't (e.g. a compromised/modified worker), reject the message.
    const { rawSignature, rawPayload } = message;

    if (!rawSignature || !rawPayload) {
      logger.error(
        '[config-poller] Worker sent source:signed without rawSignature/rawPayload — rejecting'
      );
      return;
    }

    if (!verifyConfigSignature(rawPayload, rawSignature)) {
      logger.error(
        '[config-poller] Worker config re-verification failed in main thread — rejecting'
      );
      return;
    }

    await applyConfig(configs, 'signed');
  } else if (source === 'unsigned') {
    // Unsigned path — only allowed when the operator has opted in.
    if (process.env.CONFIG_SYNC_ALLOW_UNSIGNED !== 'true') {
      logger.warn('[config-poller] Worker sent unsigned config but CONFIG_SYNC_ALLOW_UNSIGNED is not set — rejecting');
      return;
    }
    await applyConfig(configs, 'unsigned');
  } else {
    logger.warn({ source }, '[config-poller] Worker sent unknown config source — rejecting');
  }
}

function stopConfigPoller() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
  if (configWorker) {
    configWorker.terminate();
    configWorker = null;
  }
  if (redisClient) {
    redisClient.disconnect();
    redisClient = null;
  }
}

module.exports = {
  startConfigPoller,
  stopConfigPoller,
  pollConfig,
  applyConfig,
  verifyConfigSignature,
  handleWorkerConfigUpdate,
  dynamicConfig,
  CONFIG_ALLOWLIST,
};
