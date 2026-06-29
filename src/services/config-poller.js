const Redis = require('ioredis');
const { getRedisConnectionOptions } = require('../queue/redis');
const { logger } = require('../logger');
const { verifyJwt } = require('./jwt');
const { Worker } = require('worker_threads');
const path = require('path');

let pollerInterval = null;
let redisClient = null;
let configWorker = null;

// Dynamic config cache
const dynamicConfig = {};

// Config signature verification
const CONFIG_SIGNATURE_KEY = 'vero:config:signature';
const CONFIG_PAYLOAD_KEY = 'vero:config:payload';

function verifyConfigSignature(payload, signature) {
  try {
    const decoded = verifyJwt(signature);
    
    // Verify the payload matches the signed content
    if (decoded.payload !== payload) {
      throw new Error('Config payload does not match signature');
    }
    
    logger.info({ issuer: decoded.iss }, '[config-poller] Config signature verified');
    return true;
  } catch (error) {
    logger.warn({ error: error.message }, '[config-poller] Config signature verification failed');
    return false;
  }
}

async function pollConfig() {
  try {
    if (!redisClient) {
      const redisOpts = getRedisConnectionOptions();
      redisClient = new Redis(redisOpts);
      
      // Handle connection errors gracefully without crashing the app
      redisClient.on('error', (err) => {
        logger.warn({ error: err.message }, '[config-poller] Redis client connection error');
      });
    }
    
    // Check for signed config first (security requirement)
    const signature = await redisClient.get(CONFIG_SIGNATURE_KEY);
    const payload = await redisClient.get(CONFIG_PAYLOAD_KEY);
    
    if (signature && payload) {
      if (verifyConfigSignature(payload, signature)) {
        const configs = JSON.parse(payload);
        await applyConfig(configs, 'signed');
        return;
      } else {
        logger.warn('[config-poller] Signed config verification failed, falling back to unsigned config');
      }
    }
    
    // Fallback to unsigned config for backward compatibility
    const configs = await redisClient.hgetall('vero:config');
    if (configs && Object.keys(configs).length > 0) {
      await applyConfig(configs, 'unsigned');
    }
  } catch (error) {
    logger.warn({ error: error.message }, '[config-poller] Failed to poll config from Redis, using existing env');
  }
}

async function applyConfig(configs, source) {
  logger.info({ keys: Object.keys(configs), source }, '[config-poller] Applying dynamic config');
  
  for (const [key, value] of Object.entries(configs)) {
    if (value !== undefined && value !== null) {
      // Use dotenv override pattern - update process.env
      process.env[key] = value;
      dynamicConfig[key] = value;
    }
  }

  // Special handling for LOG_LEVEL
  if (configs.LOG_LEVEL) {
    logger.level = configs.LOG_LEVEL;
  }
  
  // Clear fee engine cache when config changes to ensure new values are used
  const { clearFeeEstimateCache } = require('./fee-engine');
  clearFeeEstimateCache();
}

function startConfigPoller() {
  if (pollerInterval) return;

  const intervalMs = Number(process.env.CONFIG_SYNC_INTERVAL_MS) || 5000;
  const useAsyncWorker = process.env.CONFIG_ASYNC_WORKER === 'true';
  
  if (useAsyncWorker) {
    // Use async worker for performance optimization
    startConfigWorker();
  } else {
    // Use direct polling (default for backward compatibility)
    pollConfig().then(() => {
      pollerInterval = setInterval(pollConfig, intervalMs);
      if (pollerInterval && typeof pollerInterval.unref === 'function') {
        pollerInterval.unref();
      }
    });
  }
}

function startConfigWorker() {
  if (configWorker) return;
  
  const workerPath = path.join(__dirname, 'config-worker.js');
  configWorker = new Worker(workerPath, {
    workerData: {
      intervalMs: Number(process.env.CONFIG_SYNC_INTERVAL_MS) || 5000,
      redisOpts: getRedisConnectionOptions()
    }
  });
  
  configWorker.on('message', (message) => {
    if (message.type === 'configUpdate') {
      applyConfig(message.configs, message.source).catch(err => {
        logger.error({ error: err.message }, '[config-poller] Failed to apply worker config');
      });
    } else if (message.type === 'error') {
      logger.warn({ error: message.error }, '[config-poller] Worker reported error');
    }
  });
  
  configWorker.on('error', (err) => {
    logger.error({ error: err.message }, '[config-poller] Config worker error');
  });
  
  configWorker.on('exit', (code) => {
    if (code !== 0) {
      logger.warn({ code }, '[config-poller] Config worker exited unexpectedly');
      configWorker = null;
    }
  });
  
  logger.info('[config-poller] Started async config worker');
}

function stopConfigPoller() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
  if (configWorker) {
    configWorker.terminate();
    configWorker = null;
  }
  if (redisClient) {
    redisClient.disconnect();
    redisClient = null;
  }
}

module.exports = {
  startConfigPoller,
  stopConfigPoller,
  pollConfig,
  applyConfig,
  verifyConfigSignature,
  dynamicConfig
};
