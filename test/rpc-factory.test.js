'use strict';

const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const { logger } = require('../src/logger');

process.env.STELLAR_HORIZON_URLS = 'https://horizon-1.example.com,https://horizon-2.example.com';
process.env.STELLAR_RPC_URLS = 'https://rpc-1.example.com,https://rpc-2.example.com';

const { RpcFactory } = require('../src/services/rpc-factory');

// ---------------------------------------------------------------------------
// Failover — a failing node must be logged and rotated past, not crash
// ---------------------------------------------------------------------------

test('logger.warn is a real function (regression guard for broken import)', () => {
  assert.equal(typeof logger.warn, 'function');
});

test('withHorizonFailover logs a warning and rotates to the next node on failure', async () => {
  const factory = new RpcFactory();
  const warnSpy = mock.method(logger, 'warn', () => {});

  try {
    let calls = 0;
    const result = await factory.withHorizonFailover(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('connection refused');
      }
      return 'success';
    });

    assert.equal(result, 'success');
    assert.equal(calls, 2);
    assert.equal(factory.currentHorizonIndex, 1, 'should have rotated to the second node');
    assert.ok(warnSpy.mock.calls.length >= 1, 'logger.warn should have been called instead of throwing');
  } finally {
    warnSpy.mock.restore();
  }
});

test('withHorizonFailover throws the last error when every node fails', async () => {
  const factory = new RpcFactory();
  const warnSpy = mock.method(logger, 'warn', () => {});

  try {
    await assert.rejects(
      factory.withHorizonFailover(async () => {
        throw new Error('all nodes down');
      }),
      /all nodes down/
    );
    assert.ok(warnSpy.mock.calls.length >= 1);
  } finally {
    warnSpy.mock.restore();
  }
});

test('withRpcFailover logs a warning and rotates to the next node on failure', async () => {
  const factory = new RpcFactory();
  const warnSpy = mock.method(logger, 'warn', () => {});

  try {
    let calls = 0;
    const result = await factory.withRpcFailover(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('timeout');
      }
      return 'ok';
    });

    assert.equal(result, 'ok');
    assert.equal(calls, 2);
    assert.equal(factory.currentRpcIndex, 1, 'should have rotated to the second RPC node');
    assert.ok(warnSpy.mock.calls.length >= 1, 'logger.warn should have been called instead of throwing');
  } finally {
    warnSpy.mock.restore();
  }
});

test('withRpcFailover throws the last error when every node fails', async () => {
  const factory = new RpcFactory();
  const warnSpy = mock.method(logger, 'warn', () => {});

  try {
    await assert.rejects(
      factory.withRpcFailover(async () => {
        throw new Error('all rpc nodes down');
      }),
      /all rpc nodes down/
    );
    assert.ok(warnSpy.mock.calls.length >= 1);
  } finally {
    warnSpy.mock.restore();
  }
});

test('rotateHorizonNode logs a warning and advances the index', () => {
  const factory = new RpcFactory();
  const warnSpy = mock.method(logger, 'warn', () => {});

  try {
    factory.rotateHorizonNode();
    assert.equal(factory.currentHorizonIndex, 1);
    assert.equal(warnSpy.mock.calls.length, 1);
  } finally {
    warnSpy.mock.restore();
  }
});

test('rotateRpcNode logs a warning and advances the index', () => {
  const factory = new RpcFactory();
  const warnSpy = mock.method(logger, 'warn', () => {});

  try {
    factory.rotateRpcNode();
    assert.equal(factory.currentRpcIndex, 1);
    assert.equal(warnSpy.mock.calls.length, 1);
  } finally {
    warnSpy.mock.restore();
  }
});
