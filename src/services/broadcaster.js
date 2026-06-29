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

// Wrapped fetch function — created once at module scope so the closure
// and Redis error handlers are not re-allocated on every call.
let cachedFetchAccount = null;

function getCachedFetchAccount() {
  if (!cachedFetchAccount) {
    cachedFetchAccount = getRpcCache().wrap(
      (server, accountId) =>
        retry(
          () => server.loadAccount(accountId),
          {
            maxRetries: 3,
            baseDelay: 500,
            onRetry: ({ attempt, delay, error }) => {
              transactionLogger.retrying({ attempt: attempt + 1, delay, account: accountId }, error, '[broadcaster] Account fetch retry');
            },
          }
        ),
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
    async (attempt) => {
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
 * Fetch a Stellar account, with Redis caching to reduce RPC calls.
 *
 * Cache TTL is intentionally short (default 10s) because the account sequence
 * number advances after every transaction. Longer TTLs risk sequence-number
 * conflicts on concurrent submissions.
 *
 * The cache key incorporates the network so testnet and mainnet lookups
 * never collide, and the account id so different accounts are cached
 * independently.
 */
async function fetchAccount(server, accountId) {
  return getCachedFetchAccount()(server, accountId);
}

module.exports = { broadcastTransaction, fetchAccount };

// Export the cache instance for testing
module.exports.getRpcCache = getRpcCache;
module.exports.getCachedFetchAccount = getCachedFetchAccount;
