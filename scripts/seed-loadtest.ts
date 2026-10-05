// P9b load test seed (TEST-ONLY data; .github/workflows/loadtest.yml): synthetic observations for every public
// primary series of the compose stack's database, for the last N days at each series' expected step, with the
// rollups, obs_latest, the publishers' dirty rows and the settled days' version bump that the loader would have
// written. The same generators as the e2e API (apps/server/test/e2e/seed.ts). Nothing owner: only series whose
// effective audience is public are seeded.
//
// How it reaches the database: the db service has no superuser over TCP (pg_hba: the superuser exists only on the
// container's socket), so the script writes SQL and pipes it to `psql` inside the db container (`docker exec -i`,
// peer authentication as `postgres`). No Node driver and no published port are involved. It needs a docker CLI
// that may talk to the daemon (run it with sudo in CI) and nothing from node_modules.
//
// Usage: node scripts/seed-loadtest.ts [--days 3] [--now <UTC instant>] [--container rws-db-1] [--print]
//   --print writes the SQL to stdout instead of running it (for a dry run or another transport).
// Idempotent: every insert is ON CONFLICT DO NOTHING, and a second run only moves a day's version up to 2 once.
import { spawnSync } from 'node:child_process';
import { latestUpsertSql, obsInsertSql, rollupInsertSql } from '../apps/server/test/e2e/seed.ts';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A UTC day is settled once its end is 48 hours ago (the publisher's rule, packages/contracts static.ts). */
const SETTLE_MS = 48 * HOUR_MS;
const iso = (ms: number) => new Date(ms).toISOString();

/** The SQL script of one seed, in transactions of one UTC day each (a day is about a fifth of a million rows). */
export function seedSql(nowMs: number, days: number): string {
  const nowS = Math.floor(nowMs / 1000) * 1000;
  const from = Math.floor((nowS - days * DAY_MS) / DAY_MS) * DAY_MS;
  const out: string[] = [`SELECT ensure_partitions(${lit(from)}, ${lit(nowS)});`];
  for (let d = from; d <= nowS; d += DAY_MS) {
    const to = Math.min(d + DAY_MS - 1000, nowS);
    out.push('BEGIN;', `${obsInsertSql({ from: iso(d), to: iso(to) })};`, 'COMMIT;');
  }
  const hours = Math.floor(nowS / HOUR_MS) * HOUR_MS;
  const midnight = Math.floor(nowS / DAY_MS) * DAY_MS;
  out.push(
    'BEGIN;',
    `${rollupInsertSql('obs_1h', { from: iso(from), to: iso(hours) })};`,
    `${rollupInsertSql('obs_1d', { from: iso(from), to: iso(midnight) })};`,
    `${latestUpsertSql(iso(from), iso(nowS))};`,
  );
  // What the loader writes in the same transaction as the rows (load/dirty.ts): one dirty row per family and the
  // version of every settled day it reached. A day already rendered empty is thereby rendered again, as v2.
  for (const family of ['public', 'owner'])
    out.push(
      `INSERT INTO publish_dirty (family, kind, from_ts, to_ts) VALUES ('${family}', 'obs', ${lit(from)}, ${lit(nowS)});`,
    );
  for (let d = from; d + DAY_MS <= nowS - SETTLE_MS; d += DAY_MS) {
    const day = iso(d).slice(0, 10);
    for (const family of ['public', 'owner'])
      out.push(
        `INSERT INTO app_meta (key, value) VALUES ('day_versions:${family}', jsonb_build_object('${day}', jsonb_build_object('v', 2, 'reason', 'revision', 'at', ${lit(nowS)})))
         ON CONFLICT (key) DO UPDATE SET value = jsonb_set(app_meta.value, ARRAY['${day}'],
           jsonb_build_object('v', greatest(coalesce((app_meta.value -> '${day}' ->> 'v')::int, 1), 2), 'reason', 'revision', 'at', ${lit(nowS)})),
           updated_at = now();`,
      );
  }
  out.push('COMMIT;', `SELECT 'seeded', count(*) FROM obs WHERE ts >= ${lit(from)};`);
  return `${out.join('\n')}\n`;
}

const lit = (ms: number) => `'${iso(ms)}'::timestamptz`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string, fallback: string): string => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : (args[i + 1] ?? fallback);
  };
  const known = new Set(['--days', '--now', '--container', '--print']);
  const bad = args.filter((a, i) => a.startsWith('--') && !known.has(a) && !known.has(args[i - 1] ?? ''));
  const days = Number(opt('--days', '3'));
  const now = opt('--now', new Date().toISOString());
  const container = opt('--container', 'rws-db-1');
  if (bad.length > 0 || !Number.isInteger(days) || days < 1 || days > 14 || Number.isNaN(Date.parse(now))) {
    console.error(
      'usage: node scripts/seed-loadtest.ts [--days 1..14] [--now <UTC instant>] [--container <name>] [--print]',
    );
    process.exit(64);
  }
  const sql = seedSql(Date.parse(now), days);
  if (args.includes('--print')) {
    process.stdout.write(sql);
  } else {
    const run = spawnSync(
      'docker',
      ['exec', '-i', container, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'rws', '-f', '-'],
      { input: sql, stdio: ['pipe', 'inherit', 'inherit'] },
    );
    if (run.status !== 0) {
      console.error(`seed-loadtest: psql in ${container} failed (${run.status ?? run.signal})`);
      process.exit(1);
    }
    console.log(`seed-loadtest: done at ${iso(Date.now())}`);
  }
}
