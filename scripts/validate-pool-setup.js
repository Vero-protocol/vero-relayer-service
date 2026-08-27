#!/usr/bin/env node
/**
 * Validation script for PostgreSQL connection pool setup.
 * 
 * This script checks:
 * 1. Environment configuration
 * 2. Database connectivity
 * 3. Pool initialization
 * 4. Health check functionality
 * 
 * Run with: node scripts/validate-pool-setup.js
 */

require('dotenv').config();

async function validateSetup() {
  console.log('\n🔍 PostgreSQL Connection Pool Setup Validation\n');
  console.log('='.repeat(70));
  
  const results = {
    passed: 0,
    failed: 0,
    warnings: 0,
  };

  // Test 1: Environment Variables
  console.log('\n📋 Test 1: Environment Configuration');
  console.log('-'.repeat(70));
  
  const requiredVars = {
    'DATABASE_URL or PGHOST': process.env.DATABASE_URL || process.env.PGHOST,
    'PGUSER (if not using DATABASE_URL)': process.env.DATABASE_URL || process.env.PGUSER,
    'PGDATABASE (if not using DATABASE_URL)': process.env.DATABASE_URL || process.env.PGDATABASE,
  };

  const optionalVars = {
    'DB_POOL_MIN': process.env.DB_POOL_MIN || '2 (default)',
    'DB_POOL_MAX': process.env.DB_POOL_MAX || '20 (default)',
    'DB_POOL_IDLE_TIMEOUT': process.env.DB_POOL_IDLE_TIMEOUT || '30000 (default)',
    'DB_POOL_CONNECTION_TIMEOUT': process.env.DB_POOL_CONNECTION_TIMEOUT || '5000 (default)',
  };

  let envConfigured = true;
  
  for (const [key, value] of Object.entries(requiredVars)) {
    if (value) {
      console.log(`✅ ${key}: configured`);
      results.passed++;
    } else {
      console.log(`❌ ${key}: NOT CONFIGURED`);
      results.failed++;
      envConfigured = false;
    }
  }

  console.log('\nOptional configuration:');
  for (const [key, value] of Object.entries(optionalVars)) {
    console.log(`   ${key}: ${value}`);
  }

  if (!envConfigured) {
    console.log('\n❌ Environment configuration incomplete. Please configure .env file.');
    console.log('   See .env.example for reference.');
    process.exit(1);
  }

  // Test 2: Module Loading
  console.log('\n📋 Test 2: Module Loading');
  console.log('-'.repeat(70));
  
  try {
    const { pool, healthCheck, getPoolMetrics } = require('../src/db/client');
    console.log('✅ Database client module loaded successfully');
    results.passed++;
  } catch (error) {
    console.log('❌ Failed to load database client module');
    console.log(`   Error: ${error.message}`);
    results.failed++;
    process.exit(1);
  }

  // Test 3: Pool Configuration
  console.log('\n📋 Test 3: Pool Configuration');
  console.log('-'.repeat(70));
  
  try {
    const { getPoolMetrics } = require('../src/db/client');
    const metrics = getPoolMetrics();
    
    console.log(`✅ Pool initialized`);
    console.log(`   Min connections: ${metrics.minConnections}`);
    console.log(`   Max connections: ${metrics.maxConnections}`);
    console.log(`   Current total: ${metrics.totalConnections}`);
    console.log(`   Current idle: ${metrics.idleConnections}`);
    results.passed++;

    if (metrics.maxConnections > 100) {
      console.log(`⚠️  Warning: Pool max (${metrics.maxConnections}) is very high`);
      console.log('   Ensure your database can handle this many connections');
      results.warnings++;
    }
  } catch (error) {
    console.log('❌ Failed to get pool configuration');
    console.log(`   Error: ${error.message}`);
    results.failed++;
  }

  // Test 4: Database Connectivity
  console.log('\n📋 Test 4: Database Connectivity');
  console.log('-'.repeat(70));
  
  try {
    const { pool } = require('../src/db/client');
    const client = await pool.connect();
    
    try {
      const result = await client.query('SELECT 1 as test, NOW() as timestamp');
      console.log('✅ Database connection successful');
      console.log(`   Timestamp: ${result.rows[0].timestamp}`);
      results.passed++;
    } finally {
      client.release();
    }
  } catch (error) {
    console.log('❌ Failed to connect to database');
    console.log(`   Error: ${error.message}`);
    console.log('\n   Troubleshooting:');
    console.log('   1. Verify PostgreSQL is running');
    console.log('   2. Check DATABASE_URL or connection parameters');
    console.log('   3. Verify network connectivity');
    console.log('   4. Check database user permissions');
    results.failed++;
  }

  // Test 5: Health Check Function
  console.log('\n📋 Test 5: Health Check Function');
  console.log('-'.repeat(70));
  
  try {
    const { healthCheck } = require('../src/db/client');
    const health = await healthCheck();
    
    if (health.healthy) {
      console.log('✅ Health check passed');
      console.log(`   Latency: ${health.latencyMs}ms`);
      console.log(`   Pool connections: ${health.pool.total}`);
      console.log(`   Idle connections: ${health.pool.idle}`);
      results.passed++;

      if (health.latencyMs > 100) {
        console.log(`⚠️  Warning: High database latency (${health.latencyMs}ms)`);
        results.warnings++;
      }
    } else {
      console.log('❌ Health check failed');
      console.log(`   Error: ${health.error}`);
      results.failed++;
    }
  } catch (error) {
    console.log('❌ Health check function error');
    console.log(`   Error: ${error.message}`);
    results.failed++;
  }

  // Test 6: Connection Reuse
  console.log('\n📋 Test 6: Connection Reuse Test');
  console.log('-'.repeat(70));
  
  try {
    const { pool, getPoolMetrics } = require('../src/db/client');
    const initialMetrics = getPoolMetrics();
    const initialTotal = initialMetrics.totalConnections;
    
    // Execute 10 queries
    for (let i = 0; i < 10; i++) {
      await pool.query('SELECT $1::integer as num', [i]);
    }
    
    const finalMetrics = getPoolMetrics();
    const connectionsCreated = finalMetrics.totalConnections - initialTotal;
    const reuseEfficiency = ((10 - connectionsCreated) / 10 * 100).toFixed(2);
    
    console.log('✅ Connection reuse test completed');
    console.log(`   Queries executed: 10`);
    console.log(`   New connections: ${connectionsCreated}`);
    console.log(`   Reuse efficiency: ${reuseEfficiency}%`);
    results.passed++;

    if (reuseEfficiency < 70) {
      console.log(`⚠️  Warning: Low connection reuse efficiency (${reuseEfficiency}%)`);
      results.warnings++;
    }
  } catch (error) {
    console.log('❌ Connection reuse test failed');
    console.log(`   Error: ${error.message}`);
    results.failed++;
  }

  // Test 7: File Structure
  console.log('\n📋 Test 7: Documentation & Test Files');
  console.log('-'.repeat(70));
  
  const fs = require('fs');
  const path = require('path');
  
  const requiredFiles = [
    'benchmarks/pool-performance.js',
    'test/pool-integration.test.js',
    'docs/database-pooling.md',
    'docs/MIGRATION-POOL.md',
    'docs/POOL-QUICK-REFERENCE.md',
  ];

  let allFilesPresent = true;
  for (const file of requiredFiles) {
    const filePath = path.join(__dirname, '..', file);
    if (fs.existsSync(filePath)) {
      console.log(`✅ ${file}`);
      results.passed++;
    } else {
      console.log(`❌ ${file} - NOT FOUND`);
      results.failed++;
      allFilesPresent = false;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('📊 VALIDATION SUMMARY');
  console.log('='.repeat(70));
  console.log(`✅ Passed: ${results.passed}`);
  console.log(`❌ Failed: ${results.failed}`);
  console.log(`⚠️  Warnings: ${results.warnings}`);
  
  if (results.failed === 0) {
    console.log('\n✨ SUCCESS! PostgreSQL connection pool is properly configured.');
    console.log('\n📚 Next Steps:');
    console.log('   1. Run integration tests: node --test test/pool-integration.test.js');
    console.log('   2. Run benchmarks: npm run benchmark:pool');
    console.log('   3. Start application: npm start');
    console.log('   4. Check health: curl http://localhost:3000/health');
    console.log('\n📖 Documentation: docs/database-pooling.md\n');
  } else {
    console.log('\n❌ VALIDATION FAILED');
    console.log('   Please address the failed checks above.');
    console.log('   See docs/MIGRATION-POOL.md for setup instructions.\n');
    process.exit(1);
  }

  // Cleanup
  const { pool } = require('../src/db/client');
  await pool.end();
}

// Run validation
if (require.main === module) {
  validateSetup().catch(err => {
    console.error('\n💥 Fatal error during validation:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { validateSetup };
