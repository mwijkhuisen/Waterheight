import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { readSecret } from '../capture/env.ts';
import type { DB } from './generated.ts';

// Database access of the server roles (A§12.2). In production the role is fixed
// by the process (`load` is rws_load, `api` is rws_api, …) and its password is
// a Compose file secret; it never comes from the environment or a command line.

export type DbRole = 'rws_migrator' | 'rws_load' | 'rws_publish' | 'rws_api' | 'rws_owner_api';

export type DbConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | undefined;
};

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The connection settings of `role`, or an error text (exit 78). `DATABASE_URL`
 * is the development and test switch (the SessionStart hook and CI set it);
 * Compose never sets it, so production always takes the file secret.
 */
export function dbConfig(
  env: Readonly<Record<string, string | undefined>>,
  role: DbRole,
  secretsDir?: string,
): DbConfig | string {
  if (env.DATABASE_URL) {
    let url: URL;
    try {
      url = new URL(env.DATABASE_URL);
    } catch {
      return 'DATABASE_URL is not a URL';
    }
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return 'DATABASE_URL is not a postgres URL';
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      password: url.password === '' ? undefined : decodeURIComponent(url.password),
    };
  }
  const host = env.RWS_DB_HOST ?? '';
  if (!HOST.test(host)) return 'RWS_DB_HOST is missing or not a host name';
  const rawPort = env.RWS_DB_PORT ?? '5432';
  const port = /^[0-9]{1,5}$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!(port >= 1 && port <= 65535)) return 'RWS_DB_PORT is not a port';
  const database = env.RWS_DB_NAME ?? 'rws';
  if (!NAME.test(database)) return 'RWS_DB_NAME is not a database name';
  const password = readSecret(`db_${role}`, secretsDir);
  if (password === undefined) return `the file secret db_${role} is missing`;
  return { host, port, database, user: role, password };
}

export type Db = { db: Kysely<DB>; pool: pg.Pool; close: () => Promise<void> };

/** A small pool. `onError` sees only a fixed code: a driver message can quote SQL or a host. */
export function openDb(cfg: DbConfig, opts: { max: number; onError?: (code: string) => void }): Db {
  const pool = new pg.Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    ...(cfg.password === undefined ? {} : { password: cfg.password }),
    max: opts.max,
    ssl: false,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 60_000,
  });
  // An idle client that loses its connection must not take the process down.
  pool.on('error', (err) => opts.onError?.(errorCode(err)));
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool, close: () => db.destroy() };
}

/** The SQLSTATE or Node error code of a driver error, if it is a plain identifier; never its message. */
export function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : 'unknown';
}
