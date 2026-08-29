/**
 * Integration tests for PostgreSQL connection pool.
 * 
 * Run with: node --test test/pool-integration.test.js
 * 
 * Prerequisites:
 * - PostgreSQL database running
 * - DATABASE_URL or PGHOST/PGUSER/etc. configured in .env
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
require('dotenv').config();

const { pool, healthCheck, getPoolMetrics } = require('../src/db/client');

describe('PostgreSQL Connection Pool', () => {
  
  before(async () => {
    console.log('[test] Setting up test database connection...');
  });

  after(async () => {
    console.log('[test] Cleaning up connection pool...');
    await pool.end();
  });

  it('should initialize pool with correct configuration', async () => {
    const metrics = getPoolMetrics();
    
    assert.ok(metrics.minConnections >= 0, 'Min connections should be >= 0');
    assert.ok(metrics.maxConnections > 0, 'Max connections should be > 0');
    assert.ok(metrics.maxConnections >= metrics.minConnections, 'Max should be >= min');
    
    console.log(`[test] Pool configured: min=${metrics.minConnections}, max=${metrics.maxConnections}`);
  });

  it('should connect to database successfully', async () => {
    const client = await pool.connect();
    
    try {
      const result = await client.query('SELECT 1 as test');
      assert.strictEqual(result.rows[0].test, 1, 'Should return 1 from test query');
      console.log('[test] ✓ Database connection successful');
    } finally {
      client.release();
    }
  });

  it('should pass health check', async () => {
    const health = await healthCheck();
    
    assert.strictEqual(health.healthy, true, 'Health check should be healthy');
    assert.ok(health.latencyMs > 0, 'Latency should be positive');
    assert.ok(health.pool, 'Should include pool metrics');
    assert.ok(health.pool.total >= 0, 'Total connections should be >= 0');
    
    console.log(`[test] ✓ Health check passed (latency: ${health.latencyMs}ms)`);
  });

  it('should reuse connections from pool', async () => {
    const initialMetrics = getPoolMetrics();
    const initialTotal = initialMetrics.totalConnections;
    
    // Execute multiple queries
    for (let i = 0; i < 10; i++) {
      await pool.query('SELECT $1::integer as num', [i]);
    }
    
    const finalMetrics = getPoolMetrics();
    const connectionsCreated = finalMetrics.totalConnections - initialTotal;
    
    // We should create far fewer connections than queries executed
    assert.ok(connectionsCreated < 10, `Should reuse connections (created ${connectionsCreated}, expected < 10)`);
    
    console.log(`[test] ✓ Connection reuse verified (${connectionsCreated} new connections for 10 queries)`);
  });

  it('should handle concurrent queries', async () => {
    const concurrentQueries = 20;
    const queries = [];
    
    for (let i = 0; i < concurrentQueries; i++) {
      queries.push(
        pool.query('SELECT $1::integer as id, pg_sleep(0.01)', [i])
      );
    }
    
    const results = await Promise.all(queries);
    
    assert.strictEqual(results.length, concurrentQueries, 'All queries should complete');
    results.forEach((result, index) => {
      assert.strictEqual(result.rows[0].id, index, `Query ${index} should return correct id`);
    });
    
    console.log(`[test] ✓ Concurrent queries handled (${concurrentQueries} queries)`);
  });

  it('should track pool metrics correctly', async () => {
    const metrics = getPoolMetrics();
    
    assert.ok(typeof metrics.totalConnections === 'number', 'totalConnections should be a number');
    assert.ok(typeof metrics.idleConnections === 'number', 'idleConnections should be a number');
    assert.ok(typeof metrics.waitingClients === 'number', 'waitingClients should be a number');
    assert.ok(typeof metrics.totalErrors === 'number', 'totalErrors should be a number');
    
    assert.ok(metrics.idleConnections >= 0, 'Idle connections should be >= 0');
    assert.ok(metrics.waitingClients >= 0, 'Waiting clients should be >= 0');
    assert.ok(metrics.totalConnections >= metrics.idleConnections, 'Total >= idle');
    
    console.log('[test] ✓ Pool metrics valid:', metrics);
  });

  it('should handle transactions with explicit client', async () => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create a temporary test table
      await client.query(`
        CREATE TEMP TABLE test_transactions (
          id SERIAL PRIMARY KEY,
          value INTEGER NOT NULL
        )
      `);
      
      // Insert values within transaction
      await client.query('INSERT INTO test_transactions (value) VALUES ($1)', [100]);
      await client.query('INSERT INTO test_transactions (value) VALUES ($1)', [200]);
      
      await client.query('COMMIT');
      
      // Verify data persisted
      const result = await client.query('SELECT SUM(value) as total FROM test_transactions');
      assert.strictEqual(result.rows[0].total, '300', 'Transaction should commit successfully');
      
      console.log('[test] ✓ Transaction handling verified');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('should handle query errors gracefully', async () => {
    try {
      await pool.query('SELECT * FROM non_existent_table_xyz');
      assert.fail('Should have thrown an error for invalid query');
    } catch (error) {
      assert.ok(error.message.includes('does not exist') || error.message.includes('relation'), 
        'Should get expected database error');
      console.log('[test] ✓ Query error handling verified');
    }
    
    // Pool should still be functional after error
    const result = await pool.query('SELECT 1 as test');
    assert.strictEqual(result.rows[0].test, 1, 'Pool should still work after query error');
  });

  it('should release client properly in finally block', async () => {
    const beforeMetrics = getPoolMetrics();
    
    let client;
    try {
      client = await pool.connect();
      await client.query('SELECT 1');
      // Simulate some processing
      await new Promise(resolve => setTimeout(resolve, 10));
    } finally {
      if (client) {
        client.release();
      }
    }
    
    // Give pool a moment to update metrics
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const afterMetrics = getPoolMetrics();
    
    // Idle connections should increase after release
    assert.ok(afterMetrics.idleConnections >= beforeMetrics.idleConnections, 
      'Client should be returned to pool');
    
    console.log('[test] ✓ Client release verified');
  });

  it('should provide timestamp in health check', async () => {
    const health = await healthCheck();
    
    assert.ok(health.timestamp, 'Health check should include timestamp');
    
    const timestamp = new Date(health.timestamp);
    assert.ok(!isNaN(timestamp.getTime()), 'Timestamp should be valid date');
    
    // Timestamp should be recent (within last 10 seconds)
    const now = new Date();
    const diff = Math.abs(now - timestamp);
    assert.ok(diff < 10000, 'Timestamp should be recent');
    
    console.log(`[test] ✓ Health check timestamp verified: ${health.timestamp}`);
  });
});

// Run tests if executed directly
if (require.main === module) {
  console.log('\n🧪 Running PostgreSQL Connection Pool Integration Tests\n');
  console.log('='.repeat(70));
}
