const fs = require('fs');
const path = require('path');
const { pool } = require('./client');

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

/**
 * Run all SQL migration files in order.
 * Uses a pg_advisory_lock to prevent concurrent migration runs.
 */
async function runMigrations() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('[migrations] No migration files found');
    return;
  }

  const client = await pool.connect();
  try {
    // Acquire an advisory lock so only one process runs migrations
    await client.query('SELECT pg_advisory_lock(781237)');
    try {
      // Ensure migrations tracking table exists
      await client.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          name VARCHAR(256) PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      for (const file of files) {
        const { rowCount } = await client.query(
          'SELECT 1 FROM _migrations WHERE name = $1',
          [file]
        );

        if (rowCount > 0) {
          continue; // Already applied
        }

        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        console.log(`[migrations] Applying ${file}...`);

        await client.query(sql);
        await client.query(
          'INSERT INTO _migrations (name) VALUES ($1)',
          [file]
        );

        console.log(`[migrations] ${file} applied`);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(781237)');
    }
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
