const { parentPort, workerData } = require('worker_threads');
const Redis = require('ioredis');

const CONFIG_SIGNATURE_KEY = 'vero:config:signature';
const CONFIG_PAYLOAD_KEY = 'vero:config:payload';

let redisClient = null;

async function pollConfig() {
  try {
    if (!redisClient) {
      redisClient = new Redis(workerData.redisOpts);
      
      redisClient.on('error', (err) => {
        parentPort.postMessage({
          type: 'error',
          error: err.message
        });
      });
    }
    
    // Check for signed config first
    const signature = await redisClient.get(CONFIG_SIGNATURE_KEY);
    const payload = await redisClient.get(CONFIG_PAYLOAD_KEY);
    
    if (signature && payload) {
      parentPort.postMessage({
        type: 'configUpdate',
        configs: JSON.parse(payload),
        source: 'signed'
      });
      return;
    }
    
    // Fallback to unsigned config
    const configs = await redisClient.hgetall('vero:config');
    if (configs && Object.keys(configs).length > 0) {
      parentPort.postMessage({
        type: 'configUpdate',
        configs,
        source: 'unsigned'
      });
    }
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      error: error.message
    });
  }
}

// Start polling loop
async function startPolling() {
  await pollConfig();
  
  const interval = setInterval(() => {
    pollConfig().catch(err => 
      parentPort.postMessage({
        type: 'error',
        error: err.message
      })
    );
  }, workerData.intervalMs);
  
  // Unref to allow clean exit
  if (typeof interval.unref === 'function') {
    interval.unref();
  }
}

startPolling().catch(err => {
  parentPort.postMessage({
    type: 'error',
    error: err.message
  });
  process.exit(1);
});
