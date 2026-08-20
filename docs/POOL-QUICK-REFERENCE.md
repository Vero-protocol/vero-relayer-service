# PostgreSQL Pool - Quick Reference

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

## Common Usage Patterns

### Simple Query
```javascript
const { pool } = require('./src/db/client');
const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
return result.rows[0];
```

### Transaction
```javascript
const { pool } = require('./src/db/client');
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('INSERT INTO accounts (balance) VALUES ($1)', [100]);
  await client.query('UPDATE accounts SET balance = balance + 10');
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
}
```

### Advisory Lock
```javascript
const { pool } = require('./src/db/client');
const client = await pool.connect();
try {
  await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
  // ... critical section ...
  await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
} finally {
  client.release();
}
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | - | Full connection string (recommended) |
| `DB_POOL_MIN` | 2 | Minimum connections |
| `DB_POOL_MAX` | 20 | Maximum connections |
| `DB_POOL_IDLE_TIMEOUT` | 30000 | Idle timeout (ms) |
| `DB_POOL_CONNECTION_TIMEOUT` | 5000 | Connection timeout (ms) |

### Quick Tuning

```bash
# Development
DB_POOL_MIN=2 DB_POOL_MAX=10

# Production (moderate)
DB_POOL_MIN=5 DB_POOL_MAX=20

# Production (high traffic)
DB_POOL_MIN=10 DB_POOL_MAX=50
```

## Monitoring

### Health Check
```bash
curl http://localhost:3000/health | jq '.database'
```

### Get Pool Metrics
```javascript
const { getPoolMetrics } = require('./src/db/client');
const metrics = getPoolMetrics();
console.log(`Active: ${metrics.totalConnections - metrics.idleConnections}`);
```

### Watch Logs
```bash
npm start | grep '\[db\]'
```

## Testing

```bash
# Run integration tests
node --test tests/pool-integration.test.js

# Run performance benchmarks
npm run benchmark:pool

# Quick connection test
node -e "require('dotenv').config(); require('./src/db/client').healthCheck().then(r => console.log(r))"
```

## Common Mistakes

### Don't: Forget to Release
```javascript
const client = await pool.connect();
await client.query('SELECT 1');
// ❌ Missing client.release() - connection leak!
```

### Do: Always Release in Finally
```javascript
const client = await pool.connect();
try {
  await client.query('SELECT 1');
} finally {
  client.release(); // Guaranteed release
}
```

### Don't: Create New Pool
```javascript
// Creates duplicate pool
const { Pool } = require('pg');
const myPool = new Pool({ ... });
```

### Do: Use Singleton
```javascript
// Uses shared pool
const { pool } = require('./src/db/client');
```

## Troubleshooting

### Connection Timeout
```bash
DB_POOL_CONNECTION_TIMEOUT=10000
psql $DATABASE_URL -c "SELECT 1"
```

### Pool Exhausted
```bash
DB_POOL_MAX=50
# Check for leaks: acquired count should equal released count
```

### Too Many Connections
```sql
SELECT count(*) FROM pg_stat_activity WHERE datname = 'your_db';
SHOW max_connections;
```

## Performance Tips

1. Use `pool.query()` for simple queries (automatic management)
2. Use `pool.connect()` only for transactions or locks
3. Always release in `finally` blocks
4. Set `DB_POOL_MAX` < database `max_connections`
5. Monitor `waitingClients` metric (should stay at 0)

## Security Checklist

- [ ] Credentials in `.env` only
- [ ] `.env` in `.gitignore`
- [ ] Strong database password
- [ ] SSL enabled for remote connections
- [ ] Minimum database privileges
- [ ] No credentials in logs

## More Information

- [Full Documentation](./database-pooling.md)
- [node-postgres Docs](https://node-postgres.com/features/pooling)
