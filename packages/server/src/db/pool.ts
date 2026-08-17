import pg from 'pg';
import { config } from '../config.js';

const { Pool, types } = pg;

// node-postgres hands back int8 (bigint) as a string to avoid precision loss.
// Our bigints are ids and counts well inside Number.MAX_SAFE_INTEGER, and the
// alternative is stringly-typed ids leaking through the whole API layer.
types.setTypeParser(types.builtins.INT8, (v) => Number(v));
// numeric/decimal likewise -- avg() over double precision comes back numeric.
types.setTypeParser(types.builtins.NUMERIC, (v) => Number(v));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolSize,
      // Fail fast rather than queueing behind a database that is not there.
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => {
      console.error('[db] idle client error', err);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Run a function inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
