import { Pool } from "pg";

/**
 * PostgreSQL connection pool.
 * Reads credentials from environment variables – never hard‑coded.
 * Configurable min/max pool size via PG_POOL_MIN / PG_POOL_MAX.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  min: Number(process.env.PG_POOL_MIN) || 0,
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

let closePromise: Promise<void> | null = null;

export function closeDbPool(): Promise<void> {
  if (!closePromise) {
    closePromise = pool.end();
  }

  return closePromise;
}

export default pool;
