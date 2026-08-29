const assert = require("node:assert/strict");
const { test: nodeTest } = require("node:test");
const {
  clearFeeEstimateCache,
  estimateStellarFee,
  estimateStellarFeeDetails,
  extractPercentileFee,
  getFeeEngineConfig,
  resolveCustomFee,
} = require("../src/services/fee-engine");

// estimateStellarFee/estimateStellarFeeDetails wrap client.getFeeStats() in
// a Redis-backed RPC cache keyed globally (not per-call), independent of
// each test's own mock client. Locally this cache silently degrades to a
// noop (no REDIS_HOST), but against a real Redis (CI) it stays warm across
// tests in this file and would return the first test's cached result for
// every later assertion. Clear both cache layers before every test so
// behavior doesn't depend on whether Redis happens to be reachable.
//
// node:test's top-level beforeEach() isn't available on Node 18.20 (the
// version this repo's CI actually runs), so wrap test() itself instead —
// this works on any Node version that has node:test at all.
function test(name, fn) {
  nodeTest(name, async (t) => {
    await clearFeeEstimateCache();
    return fn(t);
  });
}

const silentLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
};

function feeStats(inclusionFee) {
  return {
    inclusionFee,
    sorobanInclusionFee: {
      p70: "1",
      p80: "1",
    },
    latestLedger: 123,
  };
}

function env(overrides = {}) {
  return {
    STELLAR_BASE_FEE: "100",
    STELLAR_MIN_FEE: "100",
    STELLAR_MAX_FEE: "1000",
    STELLAR_FEE_PERCENTILE: "p75",
    STELLAR_FEE_MULTIPLIER: "1",
    STELLAR_FEE_CACHE_MS: "0",
    ...overrides,
  };
}

test("extractPercentileFee reads p75 when the RPC response provides it", () => {
  const fee = extractPercentileFee(
    feeStats({ p75: "345", p70: "300", p80: "400" }),
    "p75",
  );

  assert.equal(fee.toString(), "345");
});

test("extractPercentileFee calculates p75 from p70 and p80 when SDK stats omit p75", () => {
  const fee = extractPercentileFee(feeStats({ p70: "700", p80: "900" }), "p75");

  assert.equal(fee.toString(), "800");
});

test("high-fee environment increases selected fee above fallback base fee", async () => {
  const client = {
    getFeeStats: async () => feeStats({ p75: "750", p70: "700", p80: "800" }),
  };

  const fee = await estimateStellarFee({
    env: env(),
    client,
    logger: silentLogger,
  });

  assert.equal(fee, "750");
  assert.ok(Number(fee) > Number(env().STELLAR_BASE_FEE));
});

test("fee is capped at the configured maximum", async () => {
  const client = {
    getFeeStats: async () =>
      feeStats({ p75: "50000", p70: "40000", p80: "60000" }),
  };

  const estimate = await estimateStellarFeeDetails({
    env: env({ STELLAR_MAX_FEE: "900" }),
    client,
    logger: silentLogger,
  });

  assert.equal(estimate.fee, "900");
  assert.equal(estimate.maxFee, "900");
});

test("fee does not go below the configured minimum", async () => {
  const client = {
    getFeeStats: async () => feeStats({ p75: "50", p70: "40", p80: "60" }),
  };

  const fee = await estimateStellarFee({
    env: env({ STELLAR_BASE_FEE: "150", STELLAR_MIN_FEE: "150" }),
    client,
    logger: silentLogger,
  });

  assert.equal(fee, "150");
});

test("RPC failure falls back to the safe base fee", async () => {
  const warnings = [];
  const client = {
    getFeeStats: async () => {
      throw new Error("rpc unavailable");
    },
  };

  const fee = await estimateStellarFee({
    env: env({ STELLAR_BASE_FEE: "250" }),
    client,
    logger: {
      log: () => {},
      warn: (message) => warnings.push(message),
    },
  });

  assert.equal(fee, "250");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /using fallback fee/);
});

test("malformed RPC response falls back safely", async () => {
  const client = {
    getFeeStats: async () =>
      feeStats({ p75: "not-a-number", p70: "also-bad", p80: "" }),
  };

  const fee = await estimateStellarFee({
    env: env({ STELLAR_BASE_FEE: "175" }),
    client,
    logger: silentLogger,
  });

  assert.equal(fee, "175");
});

test("fallback base fee is used when RPC is unavailable", async () => {
  const client = {
    getFeeStats: async () => {
      throw new Error("temporary failure");
    },
  };

  assert.equal(
    await estimateStellarFee({
      env: env({ STELLAR_BASE_FEE: "125", STELLAR_MIN_FEE: "125" }),
      client,
      logger: silentLogger,
    }),
    "125",
  );

  assert.equal(
    await estimateStellarFee({
      env: env({ STELLAR_BASE_FEE: "800", STELLAR_MAX_FEE: "800" }),
      client,
      logger: silentLogger,
    }),
    "800",
  );
});

test("baseFee below minFee throws configuration error", () => {
  assert.throws(
    () =>
      getFeeEngineConfig(
        env({ STELLAR_BASE_FEE: "50", STELLAR_MIN_FEE: "100" }),
      ),
    /STELLAR_BASE_FEE must be between STELLAR_MIN_FEE and STELLAR_MAX_FEE/,
  );
});

test("baseFee above maxFee throws configuration error", () => {
  assert.throws(
    () =>
      getFeeEngineConfig(
        env({ STELLAR_BASE_FEE: "5000", STELLAR_MAX_FEE: "1000" }),
      ),
    /STELLAR_BASE_FEE must be between STELLAR_MIN_FEE and STELLAR_MAX_FEE/,
  );
});

test("baseFee at minFee boundary does not throw", () => {
  const config = getFeeEngineConfig(
    env({ STELLAR_BASE_FEE: "100", STELLAR_MIN_FEE: "100" }),
  );
  assert.equal(config.baseFee.toString(), "100");
  assert.equal(config.minFee.toString(), "100");
});

test("baseFee at maxFee boundary does not throw", () => {
  const config = getFeeEngineConfig(
    env({ STELLAR_BASE_FEE: "1000", STELLAR_MAX_FEE: "1000" }),
  );
  assert.equal(config.baseFee.toString(), "1000");
  assert.equal(config.maxFee.toString(), "1000");
});

test("fee multiplier uses integer stroop math", async () => {
  const client = {
    getFeeStats: async () => feeStats({ p75: "101", p70: "100", p80: "102" }),
  };

  const fee = await estimateStellarFee({
    env: env({ STELLAR_FEE_MULTIPLIER: "1.5", STELLAR_MAX_FEE: "1000" }),
    client,
    logger: silentLogger,
  });

  assert.equal(fee, "152");
});

test("invalid max cap fails configuration clearly", () => {
  assert.throws(
    () => getFeeEngineConfig(env({ STELLAR_MAX_FEE: "0" })),
    /greater than 0/,
  );
  assert.throws(
    () =>
      getFeeEngineConfig(
        env({ STELLAR_MIN_FEE: "2000", STELLAR_MAX_FEE: "1000" }),
      ),
    /less than or equal/,
  );
});

test("short cache window reuses recent fee estimates only when configured", async () => {
  let calls = 0;
  const client = {
    getFeeStats: async () => {
      calls += 1;
      return feeStats({ p75: String(300 + calls) });
    },
  };

  const first = await estimateStellarFee({
    env: env({ STELLAR_FEE_CACHE_MS: "1000" }),
    client,
    logger: silentLogger,
    now: () => 1000,
  });
  const second = await estimateStellarFee({
    env: env({ STELLAR_FEE_CACHE_MS: "1000" }),
    client,
    logger: silentLogger,
    now: () => 1500,
  });

  // The in-process cache correctly treats itself as expired by this point
  // (now() is past the 1000ms window), but the underlying RPC cache has its
  // own much longer, wall-clock-based TTL and would still be warm from the
  // first call — clear it so this "expired, fetch fresh" step actually
  // exercises client.getFeeStats() again, matching what the in-process
  // cache alone would do if the RPC layer weren't present.
  await clearFeeEstimateCache();
  const third = await estimateStellarFee({
    env: env({ STELLAR_FEE_CACHE_MS: "1000" }),
    client,
    logger: silentLogger,
    now: () => 2501,
  });

  assert.equal(first, "301");
  assert.equal(second, "301");
  assert.equal(third, "302");
  assert.equal(calls, 2);
});

// ── Custom fee override ────────────────────────────────────────────────────

test("feeOverride bypasses RPC and returns the supplied fee as a string", async () => {
  let rpcCalled = false;
  const client = {
    getFeeStats: async () => {
      rpcCalled = true;
      return {};
    },
  };

  const result = await estimateStellarFeeDetails({
    env: env(),
    client,
    logger: silentLogger,
    feeOverride: "500",
  });

  assert.equal(result.fee, "500");
  assert.equal(result.source, "override");
  assert.equal(
    rpcCalled,
    false,
    "RPC must not be called when feeOverride is set",
  );
});

test("feeOverride accepts a numeric value and converts it to a string", async () => {
  const result = await estimateStellarFeeDetails({
    env: env(),
    client: { getFeeStats: async () => ({}) },
    logger: silentLogger,
    feeOverride: 750,
  });

  assert.equal(result.fee, "750");
  assert.equal(result.source, "override");
});

test("feeOverride is still clamped to the configured maximum", async () => {
  const result = await estimateStellarFeeDetails({
    env: env({ STELLAR_MAX_FEE: "400" }),
    client: { getFeeStats: async () => ({}) },
    logger: silentLogger,
    feeOverride: "9999",
  });

  assert.equal(result.fee, "400");
  assert.equal(result.source, "override");
});

test("resolveCustomFee throws on a non-integer value", () => {
  assert.throws(
    () => resolveCustomFee("not-a-number"),
    /positive integer stroop value/,
  );
  assert.throws(() => resolveCustomFee("0"), /greater than 0/);
  assert.throws(() => resolveCustomFee("1.5"), /positive integer stroop value/);
});

test("STELLAR_FEE_OVERRIDE from env is used when options.feeOverride is absent", async () => {
  let rpcCalled = false;
  const client = {
    getFeeStats: async () => {
      rpcCalled = true;
      return {};
    },
  };

  const result = await estimateStellarFeeDetails({
    env: env({ STELLAR_FEE_OVERRIDE: "888" }),
    client,
    logger: silentLogger,
  });

  assert.equal(result.fee, "888");
  assert.equal(result.source, "override");
  assert.equal(
    rpcCalled,
    false,
    "RPC must not be called when STELLAR_FEE_OVERRIDE is in env",
  );
});
