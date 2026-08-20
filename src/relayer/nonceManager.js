
'use strict';

const { pool } = require('../db/client');
const { logger } = require('../logger');

/**
 * Creates a 64-bit advisory lock key from an account ID string.
 * Uses a simple hash function to convert the Stellar account ID (G...)
 * into a number suitable for pg_advisory_lock.
 */
function accountToLockKey(accountId) {
  let hash = 0;
  for (let i = 0; i < accountId.length; i++) {
    const char = accountId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  // Ensure we get a positive 64-bit compatible number
  return Math.abs(hash);
}

/**
 * Nonce Manager ensures atomic nonce fetching and sequential transaction submission
 * using PostgreSQL advisory locks to serialize access per account.
 */
class NonceManager {
  constructor(options = {}) {
    this.pool = options.pool || pool;
    this.logger = options.logger || logger;
  }

  /**
   * Executes a transaction with guaranteed sequential nonce ordering for the given account.
   * @param accountId - Stellar account ID to lock on
   * @param fetchAccountFn - Function that fetches the latest account from Horizon and accepts fetch options
   * @param buildAndSubmitFn - Function that takes the account and submits the transaction
   */
  async withSequentialNonce(accountId, fetchAccountFn, buildAndSubmitFn) {
    const lockKey = accountToLockKey(accountId);
    const client = await this.pool.connect();

    try {
      this.logger.debug({ accountId, lockKey }, '[nonceManager] Acquiring advisory lock');
      await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
      this.logger.debug({ accountId, lockKey }, '[nonceManager] Advisory lock acquired');

      // Always fetch live account state while holding the lock. Cached account
      // snapshots can contain a sequence number consumed by the previous holder.
      const account = await fetchAccountFn({ bypassCache: true });
      this.logger.debug({ accountId, sequence: account.sequence }, '[nonceManager] Fetched latest nonce');

      // Build and submit transaction
      const result = await buildAndSubmitFn(account);

      this.logger.debug({ accountId, lockKey }, '[nonceManager] Transaction submitted, releasing lock');
      return result;
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
        this.logger.debug({ accountId, lockKey }, '[nonceManager] Advisory lock released');
      } catch (unlockError) {
        this.logger.error({ error: unlockError, accountId, lockKey }, '[nonceManager] Failed to release advisory lock');
      } finally {
        client.release();
      }
    }
  }
}

module.exports = new NonceManager();
module.exports.NonceManager = NonceManager;
module.exports.accountToLockKey = accountToLockKey;
