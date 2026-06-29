import { rpc } from '@stellar/stellar-sdk';
const rpcFactory = require('./rpc-factory');

export const DEFAULT_BASE_FEE = '100';
export const DEFAULT_MIN_FEE = '100';
export const DEFAULT_MAX_FEE = '10000';
export const DEFAULT_PERCENTILE = 'p75';
export const DEFAULT_MULTIPLIER = '1';
const DEFAULT_CACHE_MS = 0;
const DEFAULT_TIMEOUT_MS = 3000;
const CLASSIC_FEE_DISTRIBUTION = 'inclusionFee';

// Persistent Redis-backed cache for fee stats.
// Runtime implementation is in fee-engine.js which wraps getFeeStats with a
// Redis-backed cache layer (see src/services/rpc-cache.js). This TS file
// is type-checked only (noEmit: true) — the JS file is the runtime source.
export const FEE_CACHE_TTL_MS = Number(process.env.RPC_CACHE_TTL_FEE) || 60_000;

type FeeDistribution = {
  max?: string;
  min?: string;
  mode?: string;
  p10?: string;
  p20?: string;
  p30?: string;
  p40?: string;
  p50?: string;
  p60?: string;
  p70?: string;
  p75?: string;
  p80?: string;
  p90?: string;
  p95?: string;
  p99?: string;
  transactionCount?: string;
  ledgerCount?: number;
};

type FeeStatsResponse = {
  inclusionFee?: FeeDistribution;
  sorobanInclusionFee?: FeeDistribution;
  latestLedger?: number;
};

type FeeStatsClient = {
  getFeeStats(): Promise<FeeStatsResponse>;
};

type Logger = {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type Multiplier = {
  raw: string;
  numerator: bigint;
  denominator: bigint;
};

export type FeeEngineConfig = {
  rpcUrl?: string | null;
  baseFee: bigint;
  minFee: bigint;
  maxFee: bigint;
  percentile: string;
  multiplier: Multiplier;
  cacheMs: number;
  timeoutMs: number;
};

export type FeeEstimate = {
  fee: string;
  source: string;
  percentile: string;
  minFee: string;
  maxFee: string;
};

export type FeeEngineOptions = {
  env?: Record<string, string | undefined>;
  config?: FeeEngineConfig;
  client?: FeeStatsClient;
  logger?: Logger;
  now?: () => number;
  feeOverride?: string | number | null;
};

let cachedEstimate: { cacheKey: string; expiresAt: number; result: FeeEstimate } | null = null;

function parsePositiveInteger(name: string, value: string | undefined): bigint {
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

function parseOptionalPositiveInteger(name: string, value: string | undefined, fallback: string): bigint {
  return parsePositiveInteger(name, value || fallback);
}

function parseNonNegativeInteger(name: string, value: string | undefined, fallback: number): number {
  const raw = String(value ?? fallback).trim();

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return Number(raw);
}

function parsePercentile(value: string | undefined): string {
  const percentile = String(value || DEFAULT_PERCENTILE).trim();

  if (!/^p\d{1,2}$/.test(percentile)) {
    throw new Error('STELLAR_FEE_PERCENTILE must be formatted like p75');
  }

  return percentile;
}

function parseMultiplier(value: string | undefined): Multiplier {
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

function parseRpcUrl(value: string | undefined): string | null {
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

export function getFeeEngineConfig(env: Record<string, string | undefined> = process.env): FeeEngineConfig {
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

export function clampFee(fee: bigint, minFee: bigint, maxFee: bigint): bigint {
  if (fee < minFee) {
    return minFee;
  }

  if (fee > maxFee) {
    return maxFee;
  }

  return fee;
}

export function applyMultiplier(fee: bigint, multiplier: Multiplier): bigint {
  return (fee * multiplier.numerator + multiplier.denominator - 1n) / multiplier.denominator;
}

function parseFeeValue(value: string | undefined): bigint | null {
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

function getDistribution(stats: FeeStatsResponse): FeeDistribution | null {
  return stats && stats[CLASSIC_FEE_DISTRIBUTION] ? stats[CLASSIC_FEE_DISTRIBUTION] : null;
}

export function extractPercentileFee(stats: FeeStatsResponse, percentile = DEFAULT_PERCENTILE): bigint | null {
  const distribution = getDistribution(stats);

  if (!distribution) {
    return null;
  }

  const directFee = parseFeeValue(distribution[percentile as keyof FeeDistribution] as string | undefined);
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

export function createFeeStatsClient(rpcUrl: string | null): FeeStatsClient | null {
  if (!rpcUrl) {
    return rpcFactory.getSorobanServer();
  }

  const parsedUrl = new URL(rpcUrl);
  return new rpc.Server(rpcUrl, {
    allowHttp: parsedUrl.protocol === 'http:'
  }) as unknown as FeeStatsClient;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
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
      .catch((error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function getLogger(options: FeeEngineOptions): Logger {
  return options.logger || console;
}

function warn(logger: Logger, message: string): void {
  if (typeof logger.warn === 'function') {
    logger.warn(message);
    return;
  }

  if (typeof logger.error === 'function') {
    logger.error(message);
  }
}

function log(logger: Logger, message: string): void {
  if (typeof logger.log === 'function') {
    logger.log(message);
  }
}

function getCacheKey(config: FeeEngineConfig): string {
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

export function resolveCustomFee(feeOverride: string | number): bigint {
  const raw = String(feeOverride).trim();

  if (!/^\d+$/.test(raw)) {
    throw new Error('feeOverride must be a positive integer stroop value');
  }

  const parsed = BigInt(raw);

  if (parsed <= 0n) {
    throw new Error('feeOverride must be greater than 0');
  }

  return parsed;
}

export async function estimateStellarFeeDetails(options: FeeEngineOptions = {}): Promise<FeeEstimate> {
  const config = options.config || getFeeEngineConfig(options.env);
  const now = options.now ? options.now() : Date.now();
  const logger = getLogger(options);

  const env = options.env || process.env;
  // --- Custom fee override: skip RPC entirely, still enforce clamp bounds ---
  const feeOverride = (options.feeOverride !== undefined && options.feeOverride !== null)
    ? options.feeOverride
    : env.STELLAR_FEE_OVERRIDE;

  if (feeOverride !== undefined && feeOverride !== null && String(feeOverride).trim() !== '') {
    const overrideFee = resolveCustomFee(feeOverride);
    const selectedFee = clampFee(overrideFee, config.minFee, config.maxFee);

    const result: FeeEstimate = {
      fee: selectedFee.toString(),
      source: 'override',
      percentile: config.percentile,
      minFee: config.minFee.toString(),
      maxFee: config.maxFee.toString()
    };

    log(logger, `[fee] selected=${result.fee} percentile=${result.percentile} min=${result.minFee} max=${result.maxFee} source=${result.source}`);

    return result;
  }

  const cacheKey = getCacheKey(config);

  if (config.cacheMs > 0 && cachedEstimate && cachedEstimate.cacheKey === cacheKey && cachedEstimate.expiresAt > now) {
    return cachedEstimate.result;
  }

  let selectedFee = config.baseFee;
  let source = 'fallback';

  try {
    const client = options.client || createFeeStatsClient(config.rpcUrl ?? null);

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
    warn(logger, `[fee] Stellar RPC fee estimation failed; using fallback fee: ${(error as Error).message}`);
  }

  selectedFee = clampFee(applyMultiplier(selectedFee, config.multiplier), config.minFee, config.maxFee);

  const result: FeeEstimate = {
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

export async function estimateStellarFee(options: FeeEngineOptions = {}): Promise<string> {
  const estimate = await estimateStellarFeeDetails(options);
  return estimate.fee;
}

export function validateFeeConfig(env: Record<string, string | undefined> = process.env): void {
  getFeeEngineConfig(env);
}

export function clearFeeEstimateCache(): void {
  cachedEstimate = null;
}
