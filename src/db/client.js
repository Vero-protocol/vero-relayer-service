const { Pool } = require('pg');

// Create a singleton pool instance
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10), // Configurable max connections
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10), // Configurable idle timeout
  connectionTimeoutMillis: 2000, // Fail fast if connection cannot be established
});

// Health check function to verify pool connectivity
async function healthCheck() {
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      console.log('[db] Pool connectivity health check passed.');
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('[db] Pool connectivity health check failed:', error.message);
    // Depending on requirements, we could rethrow or just log.
    // For intermittent restarts, the pool handles reconnection for subsequent requests.
  }
}

// Handle errors on idle clients
pool.on('error', (err, client) => {
  console.error('[db] Unexpected error on idle client', err);
});

module.exports = {
  pool,
  healthCheck,
};
