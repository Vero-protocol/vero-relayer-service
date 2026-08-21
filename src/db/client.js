const { Pool } = require("pg");
const { logger } = require("../logger");

/**
 * PostgreSQL connection pool singleton for persistent database connections.
 * Optimized for concurrent request handling with configurable pool size.
 *
 * Environment variables:
 * - DATABASE_URL: Full connection string (takes precedence)
 * - PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE: Individual connection params
 * - DB_POOL_MIN: Minimum pool size (default: 2)
 * - DB_POOL_MAX: Maximum pool size (default: 20)
 * - DB_POOL_IDLE_TIMEOUT: Idle timeout in ms (default: 30000)
 * - DB_POOL_CONNECTION_TIMEOUT: Connection timeout in ms (default: 5000)
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || "5432", 10),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  min: parseInt(process.env.DB_POOL_MIN || "2", 10),
  max: parseInt(process.env.DB_POOL_MAX || "20", 10),
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || "30000", 10),
  connectionTimeoutMillis: parseInt(
    process.env.DB_POOL_CONNECTION_TIMEOUT || "5000",
    10,
  ),
  // Enable keep-alive to detect broken connections
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Track pool metrics for monitoring
let poolMetrics = {
  totalConnections: 0,
  idleConnections: 0,
  waitingClients: 0,
  errors: 0,
};

// Update metrics on connection lifecycle events
pool.on("connect", (client) => {
  poolMetrics.totalConnections = pool.totalCount;
  poolMetrics.idleConnections = pool.idleCount;
  poolMetrics.waitingClients = pool.waitingCount;
  logger.debug(
    {
      totalConnections: poolMetrics.totalConnections,
      idleConnections: poolMetrics.idleConnections,
      waitingClients: poolMetrics.waitingClients,
    },
    "[db] Client connected to pool",
  );
});

pool.on("acquire", (client) => {
  poolMetrics.totalConnections = pool.totalCount;
  poolMetrics.idleConnections = pool.idleCount;
  poolMetrics.waitingClients = pool.waitingCount;
  logger.debug(
    {
      totalConnections: poolMetrics.totalConnections,
      idleConnections: poolMetrics.idleConnections,
      waitingClients: poolMetrics.waitingClients,
    },
    "[db] Client acquired from pool",
  );
});

pool.on("remove", (client) => {
  poolMetrics.totalConnections = pool.totalCount;
  poolMetrics.idleConnections = pool.idleCount;
  logger.debug(
    {
      totalConnections: poolMetrics.totalConnections,
      idleConnections: poolMetrics.idleConnections,
    },
    "[db] Client removed from pool",
  );
});

// Handle errors on idle clients (connection failures, network issues)
pool.on("error", (err, client) => {
  poolMetrics.errors++;
  logger.error(
    {
      error: err.message,
      code: err.code,
      totalErrors: poolMetrics.errors,
    },
    "[db] Unexpected error on idle client",
  );
});

/**
 * Health check function to verify pool connectivity.
 * Returns pool statistics and connection status.
 */
async function healthCheck() {
  try {
    const startTime = Date.now();
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT 1 as health, NOW() as timestamp",
      );
      const latency = Date.now() - startTime;

      logger.info(
        {
          totalConnections: pool.totalCount,
          idleConnections: pool.idleCount,
          waitingClients: pool.waitingCount,
          latencyMs: latency,
        },
        "[db] Pool health check passed",
      );

      return {
        healthy: true,
        latencyMs: latency,
        pool: {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        },
        timestamp: result.rows[0].timestamp,
      };
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error(
      { error: error.message, code: error.code },
      "[db] Pool health check failed",
    );
    return {
      healthy: false,
      error: error.message,
      code: error.code,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };
  }
}

/**
 * Get current pool metrics for monitoring and diagnostics.
 */
function getPoolMetrics() {
  return {
    totalConnections: pool.totalCount,
    idleConnections: pool.idleCount,
    waitingClients: pool.waitingCount,
    maxConnections: pool.options.max,
    minConnections: pool.options.min,
    totalErrors: poolMetrics.errors,
  };
}

/**
 * Gracefully shutdown the pool, releasing all connections.
 * Should be called on application shutdown.
 */
async function shutdown() {
  logger.info("[db] Shutting down connection pool...");
  try {
    await pool.end();
    logger.info("[db] Connection pool closed successfully");
  } catch (error) {
    logger.error(
      { error: error.message },
      "[db] Error closing connection pool",
    );
    throw error;
  }
}

module.exports = {
  pool,
  healthCheck,
  getPoolMetrics,
  shutdown,
};
