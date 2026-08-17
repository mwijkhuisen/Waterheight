/**
 * Minimal forward-only migration runner.
 *
 * Files in ../migrations are applied in filename order, once each, tracked in
 * schema_migrations. Each runs inside a transaction unless it opens with
 * `-- @no-transaction`, which TimescaleDB requires for continuous aggregates
 * and policy changes.
 *
 * Deliberately hand-rolled rather than pulling in a migration framework: the
 * requirement is "versioned migrations from the first commit", and this is
 * ~80 lines against a dependency that would also want to own the connection.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { getPool } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

const NO_TRANSACTION = /^\s*--\s*@no-transaction\b/m;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function migrate(log: (msg: string) => void = console.log): Promise<MigrationResult> {
  const pool = getPool();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };

  try {
    await ensureMigrationsTable(client);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
      const previous = applied.get(file);

      if (previous !== undefined) {
        // An edited migration means the database and the repo disagree about
        // what the schema is. Fail loudly rather than silently diverging.
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was modified after being applied ` +
              `(recorded ${previous}, now ${checksum}). Add a new migration instead.`,
          );
        }
        result.skipped.push(file);
        continue;
      }

      const useTransaction = !NO_TRANSACTION.test(sql);
      log(`applying ${file}${useTransaction ? '' : ' (no transaction)'}`);

      if (useTransaction) {
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
            [file, checksum],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
        }
      } else {
        // Statements are split and run individually: without a transaction
        // there is nothing to roll back, and TimescaleDB rejects some of these
        // when sent as a multi-statement batch.
        try {
          for (const statement of splitStatements(sql)) {
            await client.query(statement);
          }
          await client.query(
            'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
            [file, checksum],
          );
        } catch (err) {
          throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
        }
      }

      result.applied.push(file);
    }

    return result;
  } finally {
    client.release();
  }
}

/**
 * Split SQL on semicolons that terminate a statement, ignoring those inside
 * string literals, dollar-quoted blocks and comments.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;

  while (i < sql.length) {
    const rest = sql.slice(i);

    const lineComment = /^--[^\n]*/.exec(rest);
    if (lineComment) {
      current += lineComment[0];
      i += lineComment[0].length;
      continue;
    }

    const blockComment = /^\/\*[\s\S]*?\*\//.exec(rest);
    if (blockComment) {
      current += blockComment[0];
      i += blockComment[0].length;
      continue;
    }

    const dollarTag = /^\$([A-Za-z_]\w*)?\$/.exec(rest);
    if (dollarTag) {
      const end = sql.indexOf(dollarTag[0], i + dollarTag[0].length);
      const stop = end === -1 ? sql.length : end + dollarTag[0].length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    const char = sql[i]!;
    if (char === "'" || char === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === char) {
          if (sql[j + 1] === char) j += 2;
          else { j += 1; break; }
        } else j += 1;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i += 1;
      continue;
    }

    current += char;
    i += 1;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}
