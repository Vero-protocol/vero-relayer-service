require('dotenv').config();

const { rpc } = require('@stellar/stellar-sdk');
const rpcFactory = require('./rpc-factory');

const DEFAULT_BASE_FEE = '100';
const DEFAULT_MIN_FEE = '100';
const DEFAULT_MAX_FEE = '10000';
const DEFAULT_PERCENTILE = 'p75';
const DEFAULT_MULTIPLIER = '1';
const DEFAULT_CACHE_MS = 0;
const DEFAULT_TIMEOUT_MS = 3000;
const CLASSIC_FEE_DISTRIBUTION = 'inclusionFee';

let cachedEstimate = null;

function parsePositiveInteger(name, value) {
  const raw = String(value || '').trim();

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer stroop value`);
  }

  const parsed = BigInt(raw);

  if (parsed <= 0n) {
    throw new Error(`${name} must be greater than 0`);
  }

  return parsed;
}

function parseOptionalPositiveInteger(name, value, fallback) {
  return parsePositiveInteger(name, value || fallback);
}

function parseNonNegativeInteger(name, value, fallback) {
  const raw = String(value ?? fallback).trim();

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return Number(raw);
}

function parsePercentile(value) {
  const percentile = String(value || DEFAULT_PERCENTILE).trim();

  if (!/^p\d{1,2}$/.test(percentile)) {
    throw new Error('STELLAR_FEE_PERCENTILE must be formatted like p75');
  }

  return percentile;
}

function parseMultiplier(value) {
  const raw = String(value || DEFAULT_MULTIPLIER).trim();

  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error('STELLAR_FEE_MULTIPLIER must be a positive decimal number');
  }

  const [whole, fraction = ''] = raw.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`);

  if (numerator <= 0n) {
    throw new Error('STELLAR_FEE_MULTIPLIER must be greater than 0');
  }

  return {
    raw,
    numerator,
    denominator
  };
}

function parseRpcUrl(value) {
  if (!value) {
    return null;
  }

  const rpcUrl = String(value).trim();
  const parsedUrl = new URL(rpcUrl);

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error('STELLAR_RPC_URL must use http or https');
  }

  return rpcUrl;
}

function getFeeEngineConfig(env = process.env) {
  const baseFee = parseOptionalPositiveInteger('STELLAR_BASE_FEE', env.STELLAR_BASE_FEE, DEFAULT_BASE_FEE);
  const minFee = parseOptionalPositiveInteger('STELLAR_MIN_FEE', env.STELLAR_MIN_FEE, DEFAULT_MIN_FEE);
  const maxFee = parseOptionalPositiveInteger('STELLAR_MAX_FEE', env.STELLAR_MAX_FEE, DEFAULT_MAX_FEE);

  if (minFee > maxFee) {
    throw new Error('STELLAR_MIN_FEE must be less than or equal to STELLAR_MAX_FEE');
  }

  return {
    baseFee,
    minFee,
    maxFee,
    percentile: parsePercentile(env.STELLAR_FEE_PERCENTILE),
    multiplier: parseMultiplier(env.STELLAR_FEE_MULTIPLIER),
    cacheMs: parseNonNegativeInteger('STELLAR_FEE_CACHE_MS', env.STELLAR_FEE_CACHE_MS, DEFAULT_CACHE_MS),
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
}

function clampFee(fee, minFee, maxFee) {
  if (fee < minFee) {
    return minFee;
  }

  if (fee > maxFee) {
    return maxFee;
  }

  return fee;
}

function applyMultiplier(fee, multiplier) {
  return (fee * multiplier.numerator + multiplier.denominator - 1n) / multiplier.denominator;
}

function parseFeeValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const raw = String(value).trim();

  if (!/^\d+$/.test(raw)) {
    return null;
  }

  const parsed = BigInt(raw);
  return parsed > 0n ? parsed : null;
}

function getDistribution(stats) {
  return stats && stats[CLASSIC_FEE_DISTRIBUTION] ? stats[CLASSIC_FEE_DISTRIBUTION] : null;
}

function extractPercentileFee(stats, percentile = DEFAULT_PERCENTILE) {
  const distribution = getDistribution(stats);

  if (!distribution) {
    return null;
  }

  const directFee = parseFeeValue(distribution[percentile]);
  if (directFee !== null) {
    return directFee;
  }

  if (percentile === 'p75') {
    const p70 = parseFeeValue(distribution.p70);
    const p80 = parseFeeValue(distribution.p80);

    if (p70 !== null && p80 !== null) {
      return (p70 + p80 + 1n) / 2n;
    }
  }

  return null;
}

function createFeeStatsClient(rpcUrl) {
  if (!rpcUrl) {
    return rpcFactory.getSorobanServer();
  }

  const parsedUrl = new URL(rpcUrl);
  return new rpc.Server(rpcUrl, {
    allowHttp: parsedUrl.protocol === 'http:'
  });
}

function withTimeout(promise, timeoutMs) {
  if (timeoutMs <= 0) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Stellar RPC fee stats lookup timed out')), timeoutMs);

    promise
      .then(value => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch(error => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function getLogger(options) {
  return options.logger || console;
}

function warn(logger, message) {
  if (typeof logger.warn === 'function') {
    logger.warn(message);
    return;
  }

  if (typeof logger.error === 'function') {
    logger.error(message);
  }
}

function log(logger, message) {
  if (typeof logger.log === 'function') {
    logger.log(message);
  }
}

function getCacheKey(config) {
  const rpcUrl = config.rpcUrl || (rpcFactory.getSorobanServer() ? rpcFactory.getSorobanServer().serverUrl : 'no-rpc');
  return [
    rpcUrl,
    config.baseFee.toString(),
    config.minFee.toString(),
    config.maxFee.toString(),
    config.percentile,
    config.multiplier.raw
  ].join('|');
}

async function estimateStellarFeeDetails(options = {}) {
  const config = options.config || getFeeEngineConfig(options.env);
  const now = options.now ? options.now() : Date.now();
  const logger = getLogger(options);
  const cacheKey = getCacheKey(config);

  if (config.cacheMs > 0 && cachedEstimate && cachedEstimate.cacheKey === cacheKey && cachedEstimate.expiresAt > now) {
    return cachedEstimate.result;
  }

  let selectedFee = config.baseFee;
  let source = 'fallback';

  try {
    const client = options.client || createFeeStatsClient(config.rpcUrl);

    if (!client) {
      warn(logger, '[fee] Stellar RPC URL not configured; using fallback fee');
    } else {
      const stats = await withTimeout(client.getFeeStats(), config.timeoutMs);
      const feeFromStats = extractPercentileFee(stats, config.percentile);

      if (feeFromStats === null) {
        warn(logger, '[fee] Stellar RPC fee stats response was missing a usable p75 fee; using fallback fee');
      } else {
        selectedFee = feeFromStats;
        source = config.percentile;
      }
    }
  } catch (error) {
    warn(logger, `[fee] Stellar RPC fee estimation failed; using fallback fee: ${error.message}`);
  }

  selectedFee = clampFee(applyMultiplier(selectedFee, config.multiplier), config.minFee, config.maxFee);

  const result = {
    fee: selectedFee.toString(),
    source,
    percentile: config.percentile,
    minFee: config.minFee.toString(),
    maxFee: config.maxFee.toString()
  };

  log(logger, `[fee] selected=${result.fee} percentile=${result.percentile} min=${result.minFee} max=${result.maxFee} source=${result.source}`);

  if (config.cacheMs > 0) {
    cachedEstimate = {
      cacheKey,
      expiresAt: now + config.cacheMs,
      result
    };
  }

  return result;
}

async function estimateStellarFee(options = {}) {
  const estimate = await estimateStellarFeeDetails(options);
  return estimate.fee;
}

function validateFeeConfig(env = process.env) {
  getFeeEngineConfig(env);
}

function clearFeeEstimateCache() {
  cachedEstimate = null;
}

module.exports = {
  DEFAULT_BASE_FEE,
  DEFAULT_MAX_FEE,
  DEFAULT_MIN_FEE,
  DEFAULT_PERCENTILE,
  applyMultiplier,
  clampFee,
  clearFeeEstimateCache,
  createFeeStatsClient,
  estimateStellarFee,
  estimateStellarFeeDetails,
  extractPercentileFee,
  getFeeEngineConfig,
  validateFeeConfig
};
