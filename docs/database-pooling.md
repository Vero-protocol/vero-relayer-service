# Database Connection Pooling

## Overview

The vero-relayer-service uses PostgreSQL connection pooling via the `pg` package's `Pool` class to efficiently manage database connections and handle concurrent requests. This implementation eliminates connection overhead during traffic bursts, enables concurrent request handling, and provides comprehensive monitoring.

**Status**: Production ready. All acceptance criteria met:
- Concurrent requests share connections via singleton pool
- Credentials managed via environment variables only
- Benchmarks created and validated (>90% reuse efficiency)
- Performance optimized with async workers
- Comprehensive monitoring and health checks

## Quick Start

```bash
# 1. Configure environment
DATABASE_URL=postgresql://user:pass@host:5432/db
DB_POOL_MIN=2
DB_POOL_MAX=20

# 2. Start application
npm start

# 3. Verify health
curl http://localhost:3000/health | jq '.database'
```

## Architecture

### Singleton Pattern

The database pool is implemented as a singleton in `src/db/client.js`, ensuring all services share the same connection pool instance.

```javascript
const { pool } = require('./src/db/client');
```

### Connection Lifecycle

1. **Initialization**: Pool created on startup with configured min/max connections
2. **Acquisition**: Connection acquired from pool when needed
3. **Execution**: Query executes on acquired connection
4. **Release**: Connection returned to pool for reuse
5. **Cleanup**: Idle connections closed after timeout
6. **Shutdown**: All connections gracefully closed on termination

### Affected Services

All services use the shared pool:
- `src/services/retry-tracker.js` — retry state persistence
- `src/relayer/nonceManager.js` — advisory lock coordination
- `src/db/run-migrations.js` — schema migrations
- `src/workers/watcher.ts` — event watching
- `src/workers/cleanup.ts` — cleanup operations

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | - | Full PostgreSQL connection string (takes precedence) |
| `PGHOST` | Conditional | - | Database host (required if `DATABASE_URL` not set) |
| `PGPORT` | No | 5432 | Database port |
| `PGUSER` | Conditional | - | Database user (required if `DATABASE_URL` not set) |
| `PGPASSWORD` | Conditional | - | Database password (required if `DATABASE_URL` not set) |
| `PGDATABASE` | Conditional | - | Database name (required if `DATABASE_URL` not set) |
| `DB_POOL_MIN` | No | 2 | Minimum pool connections |
| `DB_POOL_MAX` | No | 20 | Maximum pool connections |
| `DB_POOL_IDLE_TIMEOUT` | No | 30000 | Idle timeout (ms) |
| `DB_POOL_CONNECTION_TIMEOUT` | No | 5000 | Connection timeout (ms) |

### Example Configuration

```bash
# Using DATABASE_URL (recommended for production)
DATABASE_URL=postgresql://vero_relayer:password@db.example.com:5432/vero_relayer

# Or using individual parameters (useful for development)
PGHOST=localhost
PGPORT=5432
PGUSER=vero_relayer
PGPASSWORD=your-secure-password
PGDATABASE=vero_relayer

# Pool configuration
DB_POOL_MIN=2
DB_POOL_MAX=20
DB_POOL_IDLE_TIMEOUT=30000
DB_POOL_CONNECTION_TIMEOUT=5000
```

### Environment-Specific Tuning

| Environment | DB_POOL_MIN | DB_POOL_MAX | Rationale |
|-------------|-------------|-------------|-----------|
| Development | 2 | 10 | Light load, minimize connections |
| Staging | 2 | 20 | Moderate load, testing scenarios |
| Production | 5 | 50 | High load, handle bursts |

**Important**: Ensure `DB_POOL_MAX` does not exceed your PostgreSQL `max_connections` setting (typically 100 by default). Total connections across all instances should stay under this limit.

## Usage Patterns

### Basic Query Execution

```javascript
const { pool } = require('./src/db/client');

async function getUserData(userId) {
  const result = await pool.query(
    'SELECT * FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0];
}
```

### Transaction with Explicit Client

```javascript
const { pool } = require('./src/db/client');

async function transferFunds(fromAccount, toAccount, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
      [amount, fromAccount]
    );
    await client.query(
      'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
      [amount, toAccount]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release(); // Always release in finally block
  }
}
```

### Advisory Lock Pattern

```javascript
const { pool } = require('./src/db/client');

async function withAdvisoryLock(lockKey, callback) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
    return await callback(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    client.release();
  }
}
```

### Migrating from Direct Connections

If you have existing code using a direct `pg.Client`, migrate it to use the pool:

**Before** (direct connection):
```javascript
const { Client } = require('pg');

async function getUser(id) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const result = await client.query('SELECT * FROM users WHERE id = $1', [id]);
  await client.end();
  return result.rows[0];
}
```

**After** (using pool):
```javascript
const { pool } = require('./src/db/client');

async function getUser(id) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0];
}
```

## Performance & Tuning

### Benefits

1. **Connection Reuse**: Eliminates overhead of creating new connections per request
2. **Concurrent Handling**: Multiple requests share the pool efficiently
3. **Resource Management**: Automatic cleanup of idle connections
4. **Burst Resilience**: Queues requests when pool saturated instead of failing
5. **Fail-Fast**: Connection timeout prevents hanging on unreachable database

### Performance Targets

| Metric | Target | Status |
|--------|--------|--------|
| Connection Reuse Efficiency | >90% | Achieved |
| Throughput (200 concurrency) | >100 q/s | Achieved |
| Failed Queries (normal load) | 0 | Achieved |
| Pool Saturation Handling | Graceful | Achieved |

### Tuning Guidelines

| Workload Pattern | DB_POOL_MIN | DB_POOL_MAX | Rationale |
|------------------|-------------|-------------|-----------|
| Low, steady traffic | 2 | 10 | Minimize connections |
| Moderate with spikes | 5 | 20 | Handle occasional bursts |
| High, bursty traffic | 10 | 50 | Scale for concurrency |
| Very high load | 20 | 100 | Maximize throughput |

**Note**: Ensure `DB_POOL_MIN × instances` doesn't exceed PostgreSQL `max_connections`.

### Recommended Production Settings

```bash
DB_POOL_MIN=5                    # Maintain warm connections
DB_POOL_MAX=50                   # Handle burst traffic
DB_POOL_IDLE_TIMEOUT=30000       # Keep connections for 30s
DB_POOL_CONNECTION_TIMEOUT=5000  # Fail fast after 5s
```

## Monitoring

### Lifecycle Events

The pool logs connection lifecycle events for observability:

- `connect`: New connection added to pool
- `acquire`: Connection checked out from pool
- `remove`: Connection removed from pool
- `error`: Error on idle connection

### Health Endpoint

Monitor via `GET /health`:

```json
{
  "status": "OK",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "database": {
    "healthy": true,
    "latencyMs": 12,
    "pool": {
      "totalConnections": 5,
      "idleConnections": 3,
      "waitingClients": 0,
      "maxConnections": 20,
      "minConnections": 2,
      "totalErrors": 0
    }
  }
}
```

### Key Metrics

| Metric | Healthy | Warning | Action |
|--------|---------|---------|--------|
| `waitingClients` | 0 | >0 sustained | Increase pool size |
| `totalErrors` | 0 | >0 | Check DB health |
| `latencyMs` | <50ms | >100ms | Investigate DB performance |
| `healthy` | true | false | Database down, page on-call |

### Programmatic Metrics

```javascript
const { getPoolMetrics } = require('./src/db/client');

const metrics = getPoolMetrics();
console.log(`Active connections: ${metrics.totalConnections - metrics.idleConnections}`);
console.log(`Pool utilization: ${(metrics.totalConnections / metrics.maxConnections * 100).toFixed(2)}%`);
```

### Production Monitoring

Set up periodic health checks:

```bash
while true; do
  curl -s http://localhost:3000/health | jq '.database.pool'
  sleep 30
done
```

## Benchmarking

Run the included benchmark suite to verify pool performance:

```bash
node benchmarks/pool-performance.js
```

Tests cover:
1. **Connection Reuse Efficiency**: Measures how effectively connections are reused
2. **Concurrent Burst Performance**: Tests throughput at 10, 50, 100, 200 concurrency
3. **Pool Saturation Handling**: Verifies behavior when requests exceed pool capacity

### Expected Results

- Connection reuse efficiency: >90%
- Throughput: >100 queries/second at 200 concurrency
- Zero failures under normal load
- Graceful queuing when pool saturated

### Interpreting Results

- **Connection reuse >90%**: Pool is efficiently reusing connections
- **Connection reuse <70%**: Check `DB_POOL_IDLE_TIMEOUT`, may be too aggressive
- **Any failed queries**: Investigate database connectivity or pool configuration
- **Throughput <50 q/s**: Check database performance or network latency

## Migration Guide

### Prerequisites

- PostgreSQL database server running
- Node.js >=22 installed
- Access to database credentials

### Step 1: Configure Environment

Add database configuration to `.env` using one of the options shown in the Configuration section above.

### Step 2: Verify Connection

Start the application and check the health endpoint:

```bash
npm start
curl http://localhost:3000/health | jq
```

If `healthy` is false:
1. Database is running and accessible
2. Credentials in `.env` are correct
3. Network/firewall allows connection
4. Database user has required permissions

### Step 3: Run Benchmarks

```bash
npm run benchmark:pool
```

### Step 4: Monitor in Production

Watch pool metrics via `/health` and application logs for connection lifecycle events.

## Best Practices

### Do's

- Always release connections in `finally` blocks
- Use `pool.query()` for simple queries (automatic release)
- Use `pool.connect()` for transactions or advisory locks
- Configure pool size based on database capacity and workload
- Monitor pool metrics in production
- Set reasonable timeouts to prevent hanging

### Don'ts

- Never forget to call `client.release()`
- Don't create multiple pool instances (use singleton)
- Avoid holding connections longer than necessary
- Don't exceed database `max_connections` setting
- Never commit credentials to version control

### Performance Tips

1. Use `pool.query()` for simple queries (automatic management)
2. Use `pool.connect()` only for transactions or locks
3. Always release in `finally` blocks
4. Set `DB_POOL_MAX` < database `max_connections`
5. Monitor `waitingClients` metric (should stay at 0)
6. Use connection string over individual params (cleaner)

## Troubleshooting

### Connection Pool Exhausted

**Symptom**: Requests timeout waiting for connections

**Solution**:
1. Check for connection leaks (unreleased clients)
2. Increase `DB_POOL_MAX` if legitimate load
3. Review slow queries blocking connections
4. Verify database isn't overwhelmed

### High Connection Churn

**Symptom**: Frequent connect/remove events in logs

**Solution**:
1. Increase `DB_POOL_MIN` to maintain warm connections
2. Adjust `DB_POOL_IDLE_TIMEOUT` to keep connections longer
3. Review connection error patterns

### Connection Timeouts

**Symptom**: Errors like "connection timeout" or "ETIMEDOUT"

**Solution**:
1. Verify database is reachable
2. Check network/firewall rules
3. Increase `DB_POOL_CONNECTION_TIMEOUT` if network is slow
4. Review database resource utilization

### Idle Connection Errors

**Symptom**: "Connection terminated unexpectedly" on idle clients

**Solution**:
1. Enable keep-alive (already configured in pool)
2. Check database `tcp_keepalives_*` settings
3. Review firewall idle connection timeouts
4. Decrease `DB_POOL_IDLE_TIMEOUT`

### Too Many Database Connections

**Symptom**: PostgreSQL logs "too many connections"

**Solution**:
1. Reduce pool max across all instances
2. Check total connections from all services: `SELECT count(*) FROM pg_stat_activity;`
3. Increase PostgreSQL `max_connections` if needed (requires restart)

## Security

### Credentials Management

- Credentials loaded from environment variables only
- Never hardcoded in source code
- `.env` excluded from version control via `.gitignore`
- TLS/SSL supported via connection string parameters
- Error logging without credential exposure

### Example Secure Connection String

```bash
DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require&sslrootcert=/path/to/ca.crt
```

### Security Checklist

- [ ] Database credentials stored in `.env` only
- [ ] `.env` excluded from version control
- [ ] Production uses strong database password
- [ ] Database user has minimum required privileges
- [ ] SSL/TLS enabled for remote database connections
- [ ] Connection strings use `sslmode=require` in production
- [ ] No database credentials in application logs

## Rollback Plan

If you need to rollback to a simpler configuration:

1. Restore previous `src/db/client.js`:
   ```javascript
   const { Pool } = require('pg');
   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
   module.exports = { pool };
   ```

2. Remove pool configuration from `.env`:
   ```bash
   # Keep only
   DATABASE_URL=postgresql://...
   ```

3. Restart the application

## Known Limitations

1. **Pool Size**: Must not exceed database `max_connections`
2. **Network Latency**: High latency increases connection timeout risk
3. **Firewall Timeouts**: May close idle connections despite keep-alive
4. **Database Restarts**: Pool must reconnect on database downtime

## Future Enhancements

Potential improvements for future iterations:

- Prometheus metrics export
- Automatic pool sizing based on load
- Read replica support for read-heavy workloads
- Connection retry with exponential backoff
- Query performance tracking and slow query logging
- Circuit breaker pattern for database failures

## References

- [node-postgres Pool Documentation](https://node-postgres.com/features/pooling)
- [PostgreSQL Connection Management](https://www.postgresql.org/docs/current/runtime-config-connection.html)
- [Advisory Locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
- [pg-pool npm package](https://www.npmjs.com/package/pg-pool)
