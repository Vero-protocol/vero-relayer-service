const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  clearFeeEstimateCache,
  estimateStellarFee,
  estimateStellarFeeDetails,
  extractPercentileFee,
  getFeeEngineConfig
} = require('../src/services/fee-engine');

const silentLogger = {
  log: () => {},
  warn: () => {},
  error: () => {}
};

function feeStats(inclusionFee) {
  return {
    inclusionFee,
    sorobanInclusionFee: {
      p70: '1',
      p80: '1'
    },
    latestLedger: 123
  };
}

function env(overrides = {}) {
  return {
    STELLAR_BASE_FEE: '100',
    STELLAR_MIN_FEE: '100',
    STELLAR_MAX_FEE: '1000',
    STELLAR_FEE_PERCENTILE: 'p75',
    STELLAR_FEE_MULTIPLIER: '1',
    STELLAR_FEE_CACHE_MS: '0',
    ...overrides
  };
}

test('extractPercentileFee reads p75 when the RPC response provides it', () => {
  const fee = extractPercentileFee(feeStats({ p75: '345', p70: '300', p80: '400' }), 'p75');

  assert.equal(fee.toString(), '345');
});

test('extractPercentileFee calculates p75 from p70 and p80 when SDK stats omit p75', () => {
  const fee = extractPercentileFee(feeStats({ p70: '700', p80: '900' }), 'p75');

  assert.equal(fee.toString(), '800');
});

test('high-fee environment increases selected fee above fallback base fee', async () => {
  const client = {
    getFeeStats: async () => feeStats({ p75: '750', p70: '700', p80: '800' })
  };

  const fee = await estimateStellarFee({ env: env(), client, logger: silentLogger });

  assert.equal(fee, '750');
  assert.ok(Number(fee) > Number(env().STELLAR_BASE_FEE));
});

test('fee is capped at the configured maximum', async () => {
  const client = {
    getFeeStats: async () => feeStats({ p75: '50000', p70: '40000', p80: '60000' })
  };

  const estimate = await estimateStellarFeeDetails({
    env: env({ STELLAR_MAX_FEE: '900' }),
    client,
    logger: silentLogger
  });

  assert.equal(estimate.fee, '900');
  assert.equal(estimate.maxFee, '900');
});

test('fee does not go below the configured minimum', async () => {
  const client = {
    getFeeStats: async () => feeStats({ p75: '50', p70: '40', p80: '60' })
  };

  const fee = await estimateStellarFee({
    env: env({ STELLAR_MIN_FEE: '150' }),
    client,
    logger: silentLogger
  });

  assert.equal(fee, '150');
});

test('RPC failure falls back to the safe base fee', async () => {
  const warnings = [];
  const client = {
    getFeeStats: async () => {
      throw new Error('rpc unavailable');
    }
  };

  const fee = await estimateStellarFee({
    env: env({ STELLAR_BASE_FEE: '250' }),
    client,
    logger: {
      log: () => {},
      warn: message => warnings.push(message)
    }
  });

  assert.equal(fee, '250');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /using fallback fee/);
});

test('malformed RPC response falls back safely', async () => {
  const client = {
    getFeeStats: async () => feeStats({ p75: 'not-a-number', p70: 'also-bad', p80: '' })
  };

  const fee = await estimateStellarFee({
    env: env({ STELLAR_BASE_FEE: '175' }),
    client,
    logger: silentLogger
  });

  assert.equal(fee, '175');
});

test('fallback base fee is clamped between min and max', async () => {
  const client = {
    getFeeStats: async () => {
      throw new Error('temporary failure');
    }
  };

  assert.equal(await estimateStellarFee({
    env: env({ STELLAR_BASE_FEE: '50', STELLAR_MIN_FEE: '125' }),
    client,
    logger: silentLogger
  }), '125');

  assert.equal(await estimateStellarFee({
    env: env({ STELLAR_BASE_FEE: '5000', STELLAR_MAX_FEE: '800' }),
    client,
    logger: silentLogger
  }), '800');
});

test('fee multiplier uses integer stroop math', async () => {
  const client = {
    getFeeStats: async () => feeStats({ p75: '101', p70: '100', p80: '102' })
  };

  const fee = await estimateStellarFee({
    env: env({ STELLAR_FEE_MULTIPLIER: '1.5', STELLAR_MAX_FEE: '1000' }),
    client,
    logger: silentLogger
  });

  assert.equal(fee, '152');
});

test('invalid max cap fails configuration clearly', () => {
  assert.throws(() => getFeeEngineConfig(env({ STELLAR_MAX_FEE: '0' })), /greater than 0/);
  assert.throws(() => getFeeEngineConfig(env({ STELLAR_MIN_FEE: '2000', STELLAR_MAX_FEE: '1000' })), /less than or equal/);
});

test('short cache window reuses recent fee estimates only when configured', async () => {
  clearFeeEstimateCache();

  let calls = 0;
  const client = {
    getFeeStats: async () => {
      calls += 1;
      return feeStats({ p75: String(300 + calls) });
    }
  };

  const first = await estimateStellarFee({ env: env({ STELLAR_FEE_CACHE_MS: '1000' }), client, logger: silentLogger, now: () => 1000 });
  const second = await estimateStellarFee({ env: env({ STELLAR_FEE_CACHE_MS: '1000' }), client, logger: silentLogger, now: () => 1500 });
  const third = await estimateStellarFee({ env: env({ STELLAR_FEE_CACHE_MS: '1000' }), client, logger: silentLogger, now: () => 2501 });

  assert.equal(first, '301');
  assert.equal(second, '301');
  assert.equal(third, '302');
  assert.equal(calls, 2);

  clearFeeEstimateCache();
});
