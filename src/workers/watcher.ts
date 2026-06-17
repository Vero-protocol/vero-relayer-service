import { logger } from '../logger';

const MAX_RETRIES = 3;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

class TransactionWatcher {
  private db: Map<string, any>;

  constructor(db?: Map<string, any>) {
    this.db = db || new Map();
  }

  async checkStalledTransactions() {
    const now = Date.now();
    let requeuedCount = 0;

    for (const [txId, tx] of this.db.entries()) {
      if (tx.status === 'pending' || tx.status === 'broadcasted') {
        const timeSinceSubmission = now - (tx.lastRetryAt || tx.submittedAt);
        
        if (timeSinceSubmission > TIMEOUT_MS) {
          if (tx.retries < MAX_RETRIES) {
            logger.info({ txId, retry: tx.retries + 1 }, '[Watcher] Transaction stalled. Re-queuing.');
            tx.status = 'requeued';
            tx.retries += 1;
            tx.lastRetryAt = now;
            requeuedCount++;
          } else {
            logger.info({ txId }, '[Watcher] Transaction stalled. Max retries reached. Marking as failed.');
            tx.status = 'failed';
          }
          this.db.set(txId, tx);
        }
      }
    }
    
    return requeuedCount;
  }
}

module.exports = { TransactionWatcher, MAX_RETRIES, TIMEOUT_MS };
