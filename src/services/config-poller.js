const Redis = require('ioredis');
const { getRedisConnectionOptions } = require('../queue/redis');
const { logger } = require('../logger');

let pollerInterval = null;
let redisClient = null;
let stopped = true;
let starting = false;
let generation = 0;

// Dynamic config cache
const dynamicConfig = {};

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
    
    const configs = await redisClient.hgetall('vero:config');
    if (configs && Object.keys(configs).length > 0) {
      logger.info({ keys: Object.keys(configs) }, '[config-poller] Dynamic config loaded from Redis');
      
      for (const [key, value] of Object.entries(configs)) {
        if (value !== undefined && value !== null) {
          process.env[key] = value;
          dynamicConfig[key] = value;
        }
      }

      if (configs.LOG_LEVEL) {
        logger.level = configs.LOG_LEVEL;
      }
    }
  } catch (error) {
    logger.warn({ error: error.message }, '[config-poller] Failed to poll config from Redis, using existing env');
  }
}

function startConfigPoller() {
  if (pollerInterval || starting) return;

  stopped = false;
  starting = true;
  const startGeneration = ++generation;
  const intervalMs = Number(process.env.CONFIG_SYNC_INTERVAL_MS) || 5000;
  
  // Trigger initial poll
  pollConfig().then(() => {
    starting = false;

    if (stopped || pollerInterval || startGeneration !== generation) {
      return;
    }

    pollerInterval = setInterval(pollConfig, intervalMs);
    // Unref the interval so it doesn't block process exit in tests
    if (pollerInterval && typeof pollerInterval.unref === 'function') {
      pollerInterval.unref();
    }
  });
}

function stopConfigPoller() {
  stopped = true;
  starting = false;
  generation += 1;

  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
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
  dynamicConfig
};
