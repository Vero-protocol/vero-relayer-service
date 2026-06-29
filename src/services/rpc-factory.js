const { StellarSdk, Horizon, rpc } = require('@stellar/stellar-sdk');
const logger = require('../logger');

class RpcFactory {
  constructor() {
    this.horizonUrls = this._parseUrls('STELLAR_HORIZON_URLS', 'STELLAR_HORIZON_URL', 'horizon');
    this.rpcUrls = this._parseUrls('STELLAR_RPC_URLS', 'STELLAR_RPC_URL', 'soroban');
    this.currentHorizonIndex = 0;
    this.currentRpcIndex = 0;
    this.horizonInstances = new Map();
    this.rpcInstances = new Map();
  }

  /**
   * Return the active Stellar network name for cache key scoping.
   * @returns {string} 'testnet' or 'mainnet'
   */
  getNetwork() {
    return process.env.STELLAR_NETWORK || 'testnet';
  }

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

  getHorizonServer() {
    const url = this.horizonUrls[this.currentHorizonIndex];
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
    const url = this.rpcUrls[this.currentRpcIndex];
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
    this.currentHorizonIndex = (this.currentHorizonIndex + 1) % this.horizonUrls.length;
    logger.warn(`Rotated to next Horizon node: ${this.horizonUrls[this.currentHorizonIndex]}`);
  }

  rotateRpcNode() {
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcUrls.length;
    logger.warn(`Rotated to next Soroban RPC node: ${this.rpcUrls[this.currentRpcIndex]}`);
  }

  async withHorizonFailover(fn) {
    let lastError;
    for (let i = 0; i < this.horizonUrls.length; i++) {
      try {
        return await fn(this.getHorizonServer());
      } catch (err) {
        lastError = err;
        logger.warn(`Horizon node ${this.horizonUrls[this.currentHorizonIndex]} failed: ${err.message}`);
        if (i < this.horizonUrls.length - 1) {
          this.rotateHorizonNode();
        }
      }
    }
    throw lastError;
  }

  async withRpcFailover(fn) {
    let lastError;
    for (let i = 0; i < this.rpcUrls.length; i++) {
      try {
        return await fn(this.getSorobanServer());
      } catch (err) {
        lastError = err;
        logger.warn(`Soroban RPC node ${this.rpcUrls[this.currentRpcIndex]} failed: ${err.message}`);
        if (i < this.rpcUrls.length - 1) {
          this.rotateRpcNode();
        }
      }
    }
    throw lastError;
  }
}

module.exports = new RpcFactory();
module.exports.RpcFactory = RpcFactory;
