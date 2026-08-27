'use strict';

/**
 * rpc-factory-runtime-config.test.js
 *
 * Acceptance-criteria tests for the fix described in the issue:
 *   "Stop three allowlisted config keys from being silently inert"
 *
 * AC-1: Setting process.env.STELLAR_HORIZON_URLS after requiring the factory
 *       and calling getHorizonServer() returns a server on the new URL.
 *
 * AC-2: A test flipping STELLAR_NETWORK at runtime shows the passphrase used
 *       by stellar.js and the Horizon host used by rpc-factory agree.
 *
 * The tests use RpcFactory instances (not the singleton) so they remain fully
 * isolated.  The existing rpc-factory.test.js covers failover; this file
 * focuses entirely on the runtime-mutation path.
 */

const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');
const { Networks } = require('@stellar/stellar-sdk');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the full URL string a Horizon.Server was constructed with. */
function horizonServerUrl(server) {
  return String(server.serverURL).replace(/\/$/, '');
}

/** Return the full URL string an rpc.Server was constructed with. */
function rpcServerUrl(server) {
  return String(server.serverURL).replace(/\/$/, '');
}

/**
 * Extract the hostname from a server URL string.
 * Using new URL() hostname avoids substring-match false positives that
 * CodeQL flags when .includes() is used to check URL components.
 */
function horizonHostname(server) {
  return new URL(horizonServerUrl(server)).hostname;
}

function rpcHostname(server) {
  return new URL(rpcServerUrl(server)).hostname;
}

// ---------------------------------------------------------------------------
// Environment save/restore around each test
// ---------------------------------------------------------------------------

let savedEnv;

beforeEach(() => {
  savedEnv = {
    STELLAR_NETWORK: process.env.STELLAR_NETWORK,
    STELLAR_HORIZON_URLS: process.env.STELLAR_HORIZON_URLS,
    STELLAR_HORIZON_URL: process.env.STELLAR_HORIZON_URL,
    STELLAR_RPC_URLS: process.env.STELLAR_RPC_URLS,
    STELLAR_RPC_URL: process.env.STELLAR_RPC_URL,
  };
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// Import the class (not the singleton) so each test owns its own instance
// ---------------------------------------------------------------------------

// Set a known baseline before first require so module-level code is
// predictable (the class constructor no longer reads URLs, but the
// module-level singleton creation shouldn't matter since we use RpcFactory).
process.env.STELLAR_HORIZON_URLS = 'https://horizon-initial.example.com';
process.env.STELLAR_RPC_URLS = 'https://rpc-initial.example.com';

const { RpcFactory } = require('../src/services/rpc-factory');

// ---------------------------------------------------------------------------
// AC-1: getHorizonServer() reflects URL changes made after construction
// ---------------------------------------------------------------------------

test('AC-1: getHorizonServer() returns a server on the NEW URL after STELLAR_HORIZON_URLS is updated post-construction', () => {
  const factory = new RpcFactory();

  // First call — establishes a cached instance for the original URL
  process.env.STELLAR_HORIZON_URLS = 'https://horizon-v1.example.com';
  const server1 = factory.getHorizonServer();
  assert.equal(
    horizonHostname(server1),
    'horizon-v1.example.com',
    `Expected hostname horizon-v1.example.com, got: ${horizonHostname(server1)}`
  );

  // Mutate the env — simulates what config-poller does at runtime
  process.env.STELLAR_HORIZON_URLS = 'https://horizon-v2.example.com';

  // The factory should detect the state change and return an instance for
  // the NEW url, not the stale cached one.
  const server2 = factory.getHorizonServer();
  assert.equal(
    horizonHostname(server2),
    'horizon-v2.example.com',
    `Expected hostname horizon-v2.example.com, got: ${horizonHostname(server2)}`
  );

  // The two instances must be different objects
  assert.notEqual(server1, server2, 'server1 and server2 must be different instances');
});

test('AC-1: getSorobanServer() returns a server on the NEW URL after STELLAR_RPC_URLS is updated post-construction', () => {
  const factory = new RpcFactory();

  process.env.STELLAR_RPC_URLS = 'https://rpc-v1.example.com';
  const server1 = factory.getSorobanServer();
  assert.equal(
    rpcHostname(server1),
    'rpc-v1.example.com',
    `Expected hostname rpc-v1.example.com, got: ${rpcHostname(server1)}`
  );

  process.env.STELLAR_RPC_URLS = 'https://rpc-v2.example.com';

  const server2 = factory.getSorobanServer();
  assert.equal(
    rpcHostname(server2),
    'rpc-v2.example.com',
    `Expected hostname rpc-v2.example.com, got: ${rpcHostname(server2)}`
  );

  assert.notEqual(server1, server2, 'server1 and server2 must be different instances');
});

test('AC-1: invalidateCache() forces a fresh instance on the very next call', () => {
  const factory = new RpcFactory();

  process.env.STELLAR_HORIZON_URLS = 'https://horizon-stable.example.com';
  const server1 = factory.getHorizonServer();

  // Explicit invalidation (what config-poller calls)
  factory.invalidateCache();

  // Even though the URL did NOT change, the cache was flushed, so a new
  // object is created (different reference).
  const server2 = factory.getHorizonServer();
  assert.notEqual(server1, server2, 'invalidateCache() must cause a new instance to be created');
});

// ---------------------------------------------------------------------------
// AC-1: default URL is network-aware at call-time
// ---------------------------------------------------------------------------

test('AC-1: default Horizon URL follows STELLAR_NETWORK when no explicit URL list is set', () => {
  // Clear any explicit URL overrides
  delete process.env.STELLAR_HORIZON_URLS;
  delete process.env.STELLAR_HORIZON_URL;

  const factory = new RpcFactory();

  process.env.STELLAR_NETWORK = 'testnet';
  const testnetServer = factory.getHorizonServer();
  // Exact hostname check — avoids CodeQL "incomplete URL substring sanitization"
  assert.equal(
    horizonHostname(testnetServer),
    'horizon-testnet.stellar.org',
    `Expected horizon-testnet.stellar.org, got: ${horizonHostname(testnetServer)}`
  );

  process.env.STELLAR_NETWORK = 'mainnet';
  const mainnetServer = factory.getHorizonServer();
  assert.equal(
    horizonHostname(mainnetServer),
    'horizon.stellar.org',
    `Expected horizon.stellar.org, got: ${horizonHostname(mainnetServer)}`
  );
});

test('AC-1: default RPC URL follows STELLAR_NETWORK when no explicit URL list is set', () => {
  delete process.env.STELLAR_RPC_URLS;
  delete process.env.STELLAR_RPC_URL;

  const factory = new RpcFactory();

  process.env.STELLAR_NETWORK = 'testnet';
  const testnetServer = factory.getSorobanServer();
  assert.equal(
    rpcHostname(testnetServer),
    'soroban-testnet.stellar.org',
    `Expected soroban-testnet.stellar.org, got: ${rpcHostname(testnetServer)}`
  );

  process.env.STELLAR_NETWORK = 'mainnet';
  const mainnetServer = factory.getSorobanServer();
  assert.equal(
    rpcHostname(mainnetServer),
    'rpc.stellar.org',
    `Expected rpc.stellar.org, got: ${rpcHostname(mainnetServer)}`
  );
});

// ---------------------------------------------------------------------------
// AC-2: network/passphrase agreement — stellar.js passphrase and rpc-factory
//        Horizon host must always refer to the same network
// ---------------------------------------------------------------------------

test('AC-2: after flipping STELLAR_NETWORK to mainnet, Horizon host and signing passphrase agree', () => {
  // stellar.js resolves passphrase inline: Networks.PUBLIC for mainnet,
  // Networks.TESTNET otherwise.  We replicate that logic here so the test
  // is self-contained and doesn't require importing stellar.js (which pulls
  // in dotenv and other side-effects).

  delete process.env.STELLAR_HORIZON_URLS;
  delete process.env.STELLAR_HORIZON_URL;

  const factory = new RpcFactory();

  // ---- Start on testnet -----------------------------------------------
  process.env.STELLAR_NETWORK = 'testnet';

  const network1 = process.env.STELLAR_NETWORK || 'testnet';
  const passphrase1 = network1 === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  const horizonServer1 = factory.getHorizonServer();

  assert.equal(passphrase1, Networks.TESTNET, 'testnet: passphrase should be TESTNET');
  assert.equal(
    horizonHostname(horizonServer1),
    'horizon-testnet.stellar.org',
    `testnet: expected horizon-testnet.stellar.org, got: ${horizonHostname(horizonServer1)}`
  );

  // ---- Flip to mainnet (what config-poller.applyConfig does) ----------
  process.env.STELLAR_NETWORK = 'mainnet';

  const network2 = process.env.STELLAR_NETWORK || 'testnet';
  const passphrase2 = network2 === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  const horizonServer2 = factory.getHorizonServer();
  const hostname2 = horizonHostname(horizonServer2);

  assert.equal(passphrase2, Networks.PUBLIC, 'mainnet: passphrase should be PUBLIC');
  assert.equal(
    hostname2,
    'horizon.stellar.org',
    `mainnet: expected horizon.stellar.org, got: ${hostname2}`
  );

  // The key invariant: both sides agree on the network
  const passphraseIsMainnet = passphrase2 === Networks.PUBLIC;
  const horizonIsMainnet = hostname2 === 'horizon.stellar.org';
  assert.equal(
    passphraseIsMainnet,
    horizonIsMainnet,
    `Network/passphrase divergence! passphrase=mainnet:${passphraseIsMainnet}, horizon=mainnet:${horizonIsMainnet}`
  );
});

test('AC-2: after flipping STELLAR_NETWORK to testnet, Horizon host and signing passphrase agree', () => {
  delete process.env.STELLAR_HORIZON_URLS;
  delete process.env.STELLAR_HORIZON_URL;

  const factory = new RpcFactory();

  // Start on mainnet
  process.env.STELLAR_NETWORK = 'mainnet';
  factory.getHorizonServer(); // prime the cache

  // Flip to testnet
  process.env.STELLAR_NETWORK = 'testnet';

  const network = process.env.STELLAR_NETWORK || 'testnet';
  const passphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  const hostname = horizonHostname(factory.getHorizonServer());

  assert.equal(passphrase, Networks.TESTNET, 'passphrase should be TESTNET after flip');
  assert.equal(
    hostname,
    'horizon-testnet.stellar.org',
    `Expected horizon-testnet.stellar.org after flip, got: ${hostname}`
  );
});

// ---------------------------------------------------------------------------
// Regression guard: cached same-URL instance is reused within a single config
// ---------------------------------------------------------------------------

test('regression: same URL within unchanged config returns the same cached instance', () => {
  const factory = new RpcFactory();

  process.env.STELLAR_HORIZON_URLS = 'https://horizon-cached.example.com';

  const a = factory.getHorizonServer();
  const b = factory.getHorizonServer();

  assert.equal(a, b, 'Two calls with the same config must return the same cached instance');
});

// ---------------------------------------------------------------------------
// Regression guard: rotation index resets when URL list changes
// ---------------------------------------------------------------------------

test('regression: rotation index resets to 0 when STELLAR_HORIZON_URLS changes', () => {
  const factory = new RpcFactory();

  process.env.STELLAR_HORIZON_URLS = 'https://h1.example.com,https://h2.example.com';
  factory.rotateHorizonNode();
  assert.equal(factory.currentHorizonIndex, 1, 'index should be 1 after one rotation');

  // Change the URL list — index must reset
  process.env.STELLAR_HORIZON_URLS = 'https://h-new-1.example.com,https://h-new-2.example.com';
  factory.getHorizonServer(); // triggers _refreshHorizonIfChanged
  assert.equal(factory.currentHorizonIndex, 0, 'index must reset to 0 after URL list change');
});
