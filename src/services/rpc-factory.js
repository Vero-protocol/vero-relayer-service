const { StellarSdk, Horizon, rpc } = require('@stellar/stellar-sdk');

class RpcFactory {
  constructor() {
    this.horizonInstance = null;
    this.sorobanInstance = null;
  }

  getHorizonServer() {
    if (this.horizonInstance) {
      return this.horizonInstance;
    }

    const network = process.env.STELLAR_NETWORK || 'testnet';
    const fallbackUrl = network === 'mainnet'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org';
    
    const serverUrl = process.env.STELLAR_HORIZON_URL || fallbackUrl;
    
    // allowHttp is typically used in soroban rpc, but horizon server accepts options too
    const parsedUrl = new URL(serverUrl);
    this.horizonInstance = new Horizon.Server(serverUrl, {
      allowHttp: parsedUrl.protocol === 'http:'
    });

    return this.horizonInstance;
  }

  getSorobanServer() {
    if (this.sorobanInstance) {
      return this.sorobanInstance;
    }

    const network = process.env.STELLAR_NETWORK || 'testnet';
    const fallbackUrl = network === 'mainnet'
      ? 'https://rpc.stellar.org'
      : 'https://soroban-testnet.stellar.org';
      
    let serverUrl = process.env.STELLAR_RPC_URL || fallbackUrl;
    serverUrl = String(serverUrl).trim();
    
    const parsedUrl = new URL(serverUrl);
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error('STELLAR_RPC_URL must use http or https');
    }

    this.sorobanInstance = new rpc.Server(serverUrl, {
      allowHttp: parsedUrl.protocol === 'http:'
    });

    return this.sorobanInstance;
  }
}

// Export a singleton instance
module.exports = new RpcFactory();
