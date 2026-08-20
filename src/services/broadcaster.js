
const { retry } = require('../utils/retry');
const { transactionLogger } = require('./transaction-logger');
const { createRpcCache } = require('./rpc-cache');

const ACCOUNT_CACHE_TTL_MS = Number(process.env.RPC_CACHE_TTL_ACCOUNT) || 10_000;

// Lazily-created RPC cache instance for account lookups.
// Redis connection is deferred until first use so the module loads without
// error when Redis is not configured.
let rpcCache = null;

function getRpcCache() {
  if (!rpcCache) {
    rpcCache = createRpcCache();
  }
  return rpcCache;
}

/**
 * Load the latest account state directly from Horizon, with retries.
 *
 * This live path must be used while the sequential-nonce advisory lock is
 * held. Serving a cached account there can reuse a sequence number that a
 * previous locked transaction has already consumed.
 */
async function loadAccount(server, accountId) {
  return retry(
    () => server.loadAccount(accountId),
    {
      maxRetries: 3,
      baseDelay: 500,
      onRetry: ({ attempt, delay, error }) => {
        transactionLogger.retrying({ attempt: attempt + 1, delay, account: accountId }, error, '[broadcaster] Account fetch retry');
      },
    }
  );
}

// Wrapped fetch function — created once at module scope so the closure
// and Redis error handlers are not re-allocated on every call.
let cachedFetchAccount = null;

function getCachedFetchAccount() {
  if (!cachedFetchAccount) {
    cachedFetchAccount = getRpcCache().wrap(
      loadAccount,
      {
        keyPrefix: 'account',
        ttlMs: ACCOUNT_CACHE_TTL_MS,
        keyFn: (...args) => String(args[1]) // accountId
      }
    );
  }
  return cachedFetchAccount;
}

async function broadcastTransaction(server, transaction) {
  return retry(
    async () => {
      const result = await server.submitTransaction(transaction);
      if (!result.hash) {
        throw new Error('Transaction submission returned no hash');
      }
      return result;
    },
    {
      maxRetries: 3,
      baseDelay: 1000,
      onRetry: ({ attempt, delay, error }) => {
        transactionLogger.retrying({ attempt: attempt + 1, delay }, error, '[broadcaster] Retry submitting transaction');
      },
    }
  );
}

/**
 * Fetch a Stellar account.
 *
 * Account reads are cached by default to reduce Horizon traffic. Callers that
 * hold the sequential-nonce advisory lock must pass `{ bypassCache: true }`
 * so every transaction observes the latest on-chain sequence number.
 *
 * @param {object} server Horizon server instance
 * @param {string} accountId Stellar account ID
 * @param {object} [options]
 * @param {boolean} [options.bypassCache=false] Skip Redis and load live state
 */
async function fetchAccount(server, accountId, options = {}) {
  if (options.bypassCache === true) {
    return loadAccount(server, accountId);
  }
  return getCachedFetchAccount()(server, accountId);
}

module.exports = { broadcastTransaction, fetchAccount };

// Export the cache instance for testing
module.exports.getRpcCache = getRpcCache;
module.exports.getCachedFetchAccount = getCachedFetchAccount;
