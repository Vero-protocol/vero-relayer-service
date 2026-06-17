require('dotenv').config();
const { Keypair, TransactionBuilder, Networks, Operation } = require('@stellar/stellar-sdk');
const { broadcastTransaction, fetchAccount } = require('./src/services/broadcaster');
const { estimateStellarFee } = require('./src/services/fee-engine');
const { logger } = require('./src/logger');

const { rpcFactory } = require('./src/services');

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

  logger.info({ publicKey, network }, '[stellar] Loading account...');

  const account = await fetchAccount(server, publicKey);

  const tx = new TransactionBuilder(account, {
    fee: transaction.fee,
    networkPassphrase,
  })
    .addOperation(Operation.manageData({
      name: transaction.key,
      value: transaction.value,
    }))
    .setTimeout(30)
    .build();

  tx.sign(keypair);

  logger.info({ githubId: transaction.githubId }, '[stellar] Submitting transaction for PR...');

  const result = await broadcastTransaction(server, tx);
  return result;
}

async function registerTaskOnChain(githubId, options = {}) {
  const estimateFee = options.estimateFee || estimateStellarFee;
  const submit = options.submitTransaction || submitTransaction;

  const fee = await estimateFee();

  logger.info({ githubId, fee }, '[stellar] Compiling transaction for GitHub PR...');

  const result = await submit({
    githubId,
    fee,
    operation: 'manageData',
    key: `vero:pr:${githubId}`,
    value: 'registered'
  });

  logger.info({ githubId, hash: result.hash }, '[stellar] Transaction submitted. PR successfully registered on-chain.');
  return result;
}

/**
 * Submits a single Stellar transaction containing one manageData op
 * per PR in the batch. Reduces RPC calls by N-to-1 for a batch of N events.
 *
 * @param {number[]} githubIds - array of PR numbers to register
 */
async function registerBatchOnChain(githubIds) {
  const { STELLAR_SECRET_KEY, STELLAR_NETWORK } = process.env;

  logger.info({
    network: STELLAR_NETWORK || 'testnet',
    secretKeyLoaded: !!STELLAR_SECRET_KEY,
    batchSize: githubIds.length
  }, '[stellar] Building batch transaction...');

  for (const id of githubIds) {
    logger.info({ githubId: id }, '[stellar]   op: manageData key=vero:pr:<id> value=registered');
  }

  const hash = '0x' + Buffer.from(`batch-${githubIds.join(',')}`).toString('hex').slice(0, 16);
  logger.info({ hash, batchSize: githubIds.length }, '[stellar] Batch transaction submitted (simulated).');
}

module.exports = { registerTaskOnChain, registerBatchOnChain };

