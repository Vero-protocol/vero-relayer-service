require('dotenv').config();
const { Keypair, TransactionBuilder, Networks, Operation } = require('@stellar/stellar-sdk');
const { broadcastTransaction, fetchAccount } = require('./broadcaster');
const { estimateStellarFee } = require('./fee-engine');
const { transactionLogger } = require('./transaction-logger');
const nonceManager = require('../relayer/nonceManager');

const rpcFactory = require('./rpc-factory');

async function submitTransaction(transaction) {
  const secretKey = process.env.STELLAR_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STELLAR_SECRET_KEY environment variable is not set');
  }

  const network = process.env.STELLAR_NETWORK || 'testnet';
  const networkPassphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  const keypair = Keypair.fromSecret(secretKey);
  const publicKey = keypair.publicKey();
  const server = rpcFactory.getHorizonServer();
  const txLog = transactionLogger.child({ githubId: transaction.githubId, network });

  txLog.started({ account: publicKey }, '[stellar] Loading account with sequential nonce guarantee...');

  return nonceManager.withSequentialNonce(
    publicKey,
    (options) => fetchAccount(server, publicKey, options),
    async (account) => {
      const tx = new TransactionBuilder(account, {
        fee: transaction.fee,
        networkPassphrase,
      })
        .addOperation(
          Operation.manageData({
            name: transaction.key,
            value: transaction.value,
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(keypair);

      txLog.submitting(
        {
          account: publicKey,
          fee: transaction.fee,
          feeSource: transaction.feeSource || 'default',
        },
        '[stellar] Submitting transaction for PR...',
      );

      try {
        const result = await broadcastTransaction(server, tx);
        return result;
      } catch (error) {
        txLog.failed({ account: publicKey }, error, '[stellar] Transaction submission failed');
        throw error;
      }
    },
  );
}

/**
 * Submit one Stellar transaction with multiple manageData ops (one per PR id).
 * Only logs `confirmed` after a real broadcast succeeds.
 */
async function submitBatchTransaction({ githubIds, fee, feeSource }) {
  const secretKey = process.env.STELLAR_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STELLAR_SECRET_KEY environment variable is not set');
  }
  if (!Array.isArray(githubIds) || githubIds.length === 0) {
    throw new Error('githubIds must be a non-empty array');
  }
  if (githubIds.length > 100) {
    throw new Error('Stellar allows at most 100 operations per transaction');
  }

  const network = process.env.STELLAR_NETWORK || 'testnet';
  const networkPassphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  const keypair = Keypair.fromSecret(secretKey);
  const publicKey = keypair.publicKey();
  const server = rpcFactory.getHorizonServer();
  const batchLog = transactionLogger.child({
    network,
    batchSize: githubIds.length,
  });

  batchLog.started(
    { account: publicKey, secretKeyLoaded: true },
    '[stellar] Building batch transaction...',
  );

  return nonceManager.withSequentialNonce(
    publicKey,
    (options) => fetchAccount(server, publicKey, options),
    async (account) => {
      let builder = new TransactionBuilder(account, {
        fee,
        networkPassphrase,
      });

      for (const id of githubIds) {
        batchLog.submitting(
          { githubId: id },
          '[stellar]   op: manageData key=vero:pr:<id> value=registered',
        );
        builder = builder.addOperation(
          Operation.manageData({
            name: `vero:pr:${id}`,
            value: 'registered',
          }),
        );
      }

      const tx = builder.setTimeout(30).build();
      tx.sign(keypair);

      batchLog.submitting(
        { account: publicKey, fee, feeSource: feeSource || 'default', opCount: githubIds.length },
        '[stellar] Submitting batch transaction...',
      );

      try {
        const result = await broadcastTransaction(server, tx);
        return result;
      } catch (error) {
        batchLog.failed({ account: publicKey }, error, '[stellar] Batch transaction submission failed');
        throw error;
      }
    },
  );
}

async function registerTaskOnChain(githubId, options = {}) {
  const estimateFee = options.estimateFee || estimateStellarFee;
  const submit = options.submitTransaction || submitTransaction;

  const feeOverride = options.feeOverride;
  const fee = await estimateFee({ feeOverride });
  const feeSource = feeOverride ? 'override' : 'estimated';

  transactionLogger.started(
    { githubId, fee, feeSource },
    '[stellar] Compiling transaction for GitHub PR...',
  );

  const result = await submit({
    githubId,
    fee,
    feeSource,
    operation: 'manageData',
    key: `vero:pr:${githubId}`,
    value: 'registered',
  });

  transactionLogger.confirmed(
    { githubId, txHash: result.hash, fee, feeSource },
    '[stellar] Transaction submitted. PR successfully registered on-chain.',
  );
  return result;
}

/**
 * Submits a single Stellar transaction containing one manageData op
 * per PR in the batch. Reduces RPC calls by N-to-1 for a batch of N events.
 *
 * @param {number[]} githubIds - array of PR numbers to register
 * @param {object} [options]
 * @returns {Promise<{ hash: string }>} real broadcast result
 */
async function registerBatchOnChain(githubIds, options = {}) {
  const estimateFee = options.estimateFee || estimateStellarFee;
  const submitBatch = options.submitBatchTransaction || submitBatchTransaction;

  const feeOverride = options.feeOverride;
  // Base fee scales with op count; fee-engine may ignore this — still pass through.
  const fee = await estimateFee({ feeOverride, operationCount: githubIds.length });
  const feeSource = feeOverride ? 'override' : 'estimated';

  const result = await submitBatch({ githubIds, fee, feeSource });

  // Only after a real submission — never fabricate a hash.
  transactionLogger.confirmed(
    { txHash: result.hash, batchSize: githubIds.length, fee, feeSource },
    '[stellar] Batch transaction submitted.',
  );
  return result;
}

module.exports = {
  registerTaskOnChain,
  registerBatchOnChain,
  // exported for unit tests
  submitTransaction,
  submitBatchTransaction,
};
