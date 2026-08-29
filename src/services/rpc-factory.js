'use strict';

const { Horizon, rpc } = require('@stellar/stellar-sdk');
const { logger } = require('../logger');

class RpcFactory {
  constructor() {
    // NOTE: URLs and network are intentionally NOT snapshotted here.
    // They are resolved at call-time so that runtime changes via
    // config-poller (STELLAR_NETWORK, STELLAR_HORIZON_URLS,
    // STELLAR_RPC_URLS) take effect without a process restart.
    this.currentHorizonIndex = 0;
    this.currentRpcIndex = 0;
    this.horizonInstances = new Map();
    this.rpcInstances = new Map();

    // Cache-invalidation sentinels: track the last resolved URL list +
    // network so we know when the env has changed underneath us.
    this._lastHorizonKey = null;
    this._lastRpcKey = null;
  }

  /**
   * Return the active Stellar network name for cache key scoping.
   * Reads process.env at call-time — always current.
   * @returns {string} 'testnet' or 'mainnet'
   */
  getNetwork() {
    return process.env.STELLAR_NETWORK || 'testnet';
  }

  /**
   * Resolve the ordered list of endpoint URLs from the current environment.
   * Called at call-time, not at construction time.
   *
   * @param {'STELLAR_HORIZON_URLS'|'STELLAR_RPC_URLS'} urlsEnv
   * @param {'STELLAR_HORIZON_URL'|'STELLAR_RPC_URL'}  singleUrlEnv
   * @param {'horizon'|'soroban'} type
   * @returns {string[]}
   */
  _parseUrls(urlsEnv, singleUrlEnv, type) {
    const network = process.env.STELLAR_NETWORK || 'testnet';
    const defaultUrls = type === 'horizon'
      ? [network === 'mainnet' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org']
      : [network === 'mainnet' ? 'https://rpc.stellar.org' : 'https://soroban-testnet.stellar.org'];

    let urls = [];

    if (process.env[urlsEnv]) {
      urls = process.env[urlsEnv].split(',').map(u => u.trim()).filter(u => u);
    } else if (process.env[singleUrlEnv]) {
      urls = [process.env[singleUrlEnv].trim()];
    }

    return urls.length > 0 ? urls : defaultUrls;
  }

  /**
   * Build a stable string key that represents the current Horizon
   * configuration (network + ordered URL list).  Used to detect changes.
   */
  _horizonStateKey() {
    const urls = this._parseUrls('STELLAR_HORIZON_URLS', 'STELLAR_HORIZON_URL', 'horizon');
    return `${this.getNetwork()}|${urls.join(',')}`;
  }

  /**
   * Build a stable string key that represents the current Soroban RPC
   * configuration (network + ordered URL list).  Used to detect changes.
   */
  _rpcStateKey() {
    const urls = this._parseUrls('STELLAR_RPC_URLS', 'STELLAR_RPC_URL', 'soroban');
    return `${this.getNetwork()}|${urls.join(',')}`;
  }

  /**
   * If the resolved Horizon URL list or network has changed since the last
   * call, flush all cached Horizon.Server instances and reset the rotation
   * index so the next getHorizonServer() call starts fresh.
   */
  _refreshHorizonIfChanged() {
    const key = this._horizonStateKey();
    if (key !== this._lastHorizonKey) {
      if (this._lastHorizonKey !== null) {
        logger.info(
          { prev: this._lastHorizonKey, next: key },
          '[rpc-factory] Horizon config changed — clearing cached instances'
        );
      }
      this.horizonInstances.clear();
      this.currentHorizonIndex = 0;
      this._lastHorizonKey = key;
    }
  }

  /**
   * If the resolved Soroban RPC URL list or network has changed since the
   * last call, flush all cached rpc.Server instances and reset the rotation
   * index.
   */
  _refreshRpcIfChanged() {
    const key = this._rpcStateKey();
    if (key !== this._lastRpcKey) {
      if (this._lastRpcKey !== null) {
        logger.info(
          { prev: this._lastRpcKey, next: key },
          '[rpc-factory] Soroban RPC config changed — clearing cached instances'
        );
      }
      this.rpcInstances.clear();
      this.currentRpcIndex = 0;
      this._lastRpcKey = key;
    }
  }

  /**
   * Explicitly flush all cached server instances for both Horizon and
   * Soroban RPC.  Called by config-poller after it writes new values for
   * STELLAR_NETWORK, STELLAR_HORIZON_URLS, or STELLAR_RPC_URLS into
   * process.env so the very next getHorizonServer()/getSorobanServer() call
   * picks up the updated configuration.
   */
  invalidateCache() {
    this.horizonInstances.clear();
    this.rpcInstances.clear();
    this.currentHorizonIndex = 0;
    this.currentRpcIndex = 0;
    this._lastHorizonKey = null;
    this._lastRpcKey = null;
    logger.info('[rpc-factory] Cache explicitly invalidated');
  }

  getHorizonServer() {
    this._refreshHorizonIfChanged();

    const urls = this._parseUrls('STELLAR_HORIZON_URLS', 'STELLAR_HORIZON_URL', 'horizon');
    const url = urls[this.currentHorizonIndex];

    if (this.horizonInstances.has(url)) {
      return this.horizonInstances.get(url);
    }

    const parsedUrl = new URL(url);
    const instance = new Horizon.Server(url, {
      allowHttp: parsedUrl.protocol === 'http:'
    });
    this.horizonInstances.set(url, instance);
    return instance;
  }

  getSorobanServer() {
    this._refreshRpcIfChanged();

    const urls = this._parseUrls('STELLAR_RPC_URLS', 'STELLAR_RPC_URL', 'soroban');
    const url = urls[this.currentRpcIndex];

    if (this.rpcInstances.has(url)) {
      return this.rpcInstances.get(url);
    }

    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error('STELLAR_RPC_URL must use http or https');
    }

    const instance = new rpc.Server(url, {
      allowHttp: parsedUrl.protocol === 'http:'
    });
    this.rpcInstances.set(url, instance);
    return instance;
  }

  rotateHorizonNode() {
    this._refreshHorizonIfChanged();
    const urls = this._parseUrls('STELLAR_HORIZON_URLS', 'STELLAR_HORIZON_URL', 'horizon');
    this.currentHorizonIndex = (this.currentHorizonIndex + 1) % urls.length;
    logger.warn(`Rotated to next Horizon node: ${urls[this.currentHorizonIndex]}`);
  }

  rotateRpcNode() {
    this._refreshRpcIfChanged();
    const urls = this._parseUrls('STELLAR_RPC_URLS', 'STELLAR_RPC_URL', 'soroban');
    this.currentRpcIndex = (this.currentRpcIndex + 1) % urls.length;
    logger.warn(`Rotated to next Soroban RPC node: ${urls[this.currentRpcIndex]}`);
  }

  async withHorizonFailover(fn) {
    this._refreshHorizonIfChanged();
    const urls = this._parseUrls('STELLAR_HORIZON_URLS', 'STELLAR_HORIZON_URL', 'horizon');
    let lastError;
    for (let i = 0; i < urls.length; i++) {
      try {
        return await fn(this.getHorizonServer());
      } catch (err) {
        lastError = err;
        logger.warn(`Horizon node ${urls[this.currentHorizonIndex]} failed: ${err.message}`);
        if (i < urls.length - 1) {
          this.rotateHorizonNode();
        }
      }
    }
    throw lastError;
  }

  async withRpcFailover(fn) {
    this._refreshRpcIfChanged();
    const urls = this._parseUrls('STELLAR_RPC_URLS', 'STELLAR_RPC_URL', 'soroban');
    let lastError;
    for (let i = 0; i < urls.length; i++) {
      try {
        return await fn(this.getSorobanServer());
      } catch (err) {
        lastError = err;
        logger.warn(`Soroban RPC node ${urls[this.currentRpcIndex]} failed: ${err.message}`);
        if (i < urls.length - 1) {
          this.rotateRpcNode();
        }
      }
    }
    throw lastError;
  }
}

module.exports = new RpcFactory();
module.exports.RpcFactory = RpcFactory;
