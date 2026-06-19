const { retry } = require('../utils/retry');
const { toStellarServiceUnavailable } = require('./stellar-errors');
const { transactionLogger } = require('./transaction-logger');

async function broadcastTransaction(server, transaction, options = {}) {
  try {
    return await retry(
      async (attempt) => {
        const result = await server.submitTransaction(transaction);
        if (!result.hash) {
          throw new Error('Transaction submission returned no hash');
        }
        return result;
      },
      {
        maxRetries: options.maxRetries ?? 3,
        baseDelay: options.baseDelay ?? 1000,
        onRetry: ({ attempt, delay, error }) => {
          transactionLogger.retrying({ attempt: attempt + 1, delay }, error, '[broadcaster] Retry submitting transaction');
        },
      }
    );
  } catch (error) {
    throw toStellarServiceUnavailable(error, 'submitTransaction');
  }
}

async function fetchAccount(server, accountId, options = {}) {
  try {
    return await retry(
      () => server.loadAccount(accountId),
      {
        maxRetries: options.maxRetries ?? 3,
        baseDelay: options.baseDelay ?? 500,
        onRetry: ({ attempt, delay, error }) => {
          transactionLogger.retrying({ attempt: attempt + 1, delay, account: accountId }, error, '[broadcaster] Account fetch retry');
        },
      }
    );
  } catch (error) {
    throw toStellarServiceUnavailable(error, 'loadAccount');
  }
}

module.exports = { broadcastTransaction, fetchAccount };
