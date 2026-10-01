import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sql } from 'kysely';
import { type DbConfig, dbConfig, errorCode, openDb } from '../db/pool.ts';
import { RegistryError, readRegistry, syncRegistry } from './registry-sync.ts';

// The one-shot `migrate` role (A§11.2): dbmate applies db/migrations, then the
// partitions from the first seeds onward are created and the registry is
// synced. It logs in as rws_migrator, which acts as the object owner. The
// database URL is built here, in the process, from the file secret: it is
// never in the environment of the container, a command line or a log.

const run = promisify(execFile);

/** The first UTC month that may hold data: the P1 seeds reach back to about 2026-08-24 (A§7.5). */
export const DATA_FLOOR = '2026-08-01T00:00:00Z';

const MIGRATIONS = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

function databaseUrl(cfg: DbConfig): string {
  const auth =
    cfg.password === undefined
      ? encodeURIComponent(cfg.user)
      : `${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}`;
  return `postgres://${auth}@${cfg.host}:${cfg.port}/${encodeURIComponent(cfg.database)}?sslmode=disable`;
}

export async function runMigrate(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
): Promise<number> {
  const cfg = dbConfig(env, 'rws_migrator');
  if (typeof cfg === 'string') {
    log(`migrate: ${cfg}`);
    return 78;
  }
  const dbmate = env.RWS_DBMATE || '/app/bin/dbmate';
  const dir = env.RWS_MIGRATIONS_DIR || MIGRATIONS;
  const url = databaseUrl(cfg);
  // dbmate's output can quote the URL; everything it prints passes through this.
  const scrub = (text: string) => {
    let out = text.split(url).join('[database url]');
    if (cfg.password !== undefined)
      out = out.split(cfg.password).join('[redacted]').split(encodeURIComponent(cfg.password)).join('[redacted]');
    return out.slice(0, 4000);
  };
  try {
    // `migrate`, not `up`: the database exists (roles.sql owns it) and rws_migrator may not create one.
    // No schema dump: there is no pg_dump in the image and the file system is read-only.
    const { stdout } = await run(
      dbmate,
      ['--no-dump-schema', '--migrations-dir', dir, '--wait', '--wait-timeout', '60s', 'migrate'],
      {
        env: { DATABASE_URL: url },
        timeout: 600_000,
        maxBuffer: 1024 * 1024,
      },
    );
    for (const line of scrub(stdout).split('\n')) if (line.trim() !== '') log(`migrate: ${line}`);
  } catch (err) {
    const e = err as { stderr?: unknown; stdout?: unknown; code?: unknown };
    log(`migrate: dbmate failed (${typeof e.code === 'number' ? `exit ${e.code}` : errorCode(err)})`);
    for (const part of [e.stdout, e.stderr]) {
      if (typeof part === 'string')
        for (const line of scrub(part).split('\n')) if (line.trim() !== '') log(`migrate: ${line}`);
    }
    return 1;
  }

  const { db, close } = openDb(cfg, { max: 1 });
  try {
    const made = await sql<{ n: number }>`
      SELECT ensure_partitions(${DATA_FLOOR}::timestamptz, now() + interval '3 months') AS n`.execute(db);
    log(`migrate: ${made.rows[0]?.n ?? 0} partition(s) created`);
    const synced = await syncRegistry(db, readRegistry());
    log(
      `migrate: registry synced (${synced.sources} sources, ${synced.stations} stations, ${synced.series} series, ${synced.deactivated} deactivated, ${synced.twins} twins, ${synced.references} NL-4 class bounds)`,
    );
    return 0;
  } catch (err) {
    // A RegistryError names registry rows (our own reviewed text); a database error is reduced to its code.
    log(err instanceof RegistryError ? `migrate: ${err.message}` : `migrate: failed after dbmate (${errorCode(err)})`);
    return 1;
  } finally {
    await close();
  }
}
