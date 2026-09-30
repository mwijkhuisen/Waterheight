import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveReader } from '../../src/archive/reader.ts';
import { Archive } from '../../src/archive/writer.ts';
import { type Db, type DbConfig, dbConfig, openDb } from '../../src/db/pool.ts';
import type { LoadAdapter } from '../../src/load/adapters.ts';
import { Loader } from '../../src/load/pipeline.ts';
import { readRegistry, syncRegistry } from '../../src/load/registry-sync.ts';
import { createTestDb, type LoginRole, type TestDb } from '../db/testdb.ts';

// A loader test bench: a migrated database with the real registry synced (as
// rws_migrator), a loader that logs in as rws_load, and an empty raw archive.

export type Harness = {
  t: TestDb;
  raw: string;
  archive: Archive;
  reader: ArchiveReader;
  load: Db;
  alerts: { code: string; fields: Record<string, string | number> }[];
  loader: (opts?: { adapters?: Readonly<Record<string, LoadAdapter>>; now?: Date }) => Loader;
  dbAs: (role: LoginRole, max?: number) => Db;
  /** md5 over (series, ts, value, qc) of every obs partition: what "identical after a replay" means. */
  checksums: () => Promise<Record<string, string>>;
  count: (table: string) => Promise<number>;
  seriesId: (key: string) => Promise<number>;
  close: () => Promise<void>;
};

export async function harness(): Promise<Harness> {
  const t = await createTestDb();
  const opened: Db[] = [];
  const dbAs = (role: LoginRole, max = 2) => {
    const db = openDb(dbConfig({ DATABASE_URL: t.urlFor(role) }, role) as DbConfig, { max });
    opened.push(db);
    return db;
  };
  const owner = dbAs('rws_migrator', 1);
  await syncRegistry(owner.db, readRegistry());
  await owner.close();

  const raw = mkdtempSync(join(tmpdir(), 'rws-load-'));
  const load = dbAs('rws_load');
  const reader = new ArchiveReader(raw);
  const alerts: Harness['alerts'] = [];
  return {
    t,
    raw,
    archive: new Archive(raw),
    reader,
    load,
    alerts,
    dbAs,
    loader: (opts = {}) =>
      new Loader({
        db: load.db,
        reader,
        alert: (code, fields = {}) => alerts.push({ code, fields }),
        now: () => opts.now ?? new Date('2026-09-30T07:30:00Z'),
        ...(opts.adapters ? { adapters: opts.adapters } : {}),
      }),
    async checksums() {
      const { rows } = await t.admin.query<{ part: string; sum: string }>(
        `SELECT tableoid::regclass::text AS part,
                md5(string_agg(series_id || '|' || extract(epoch FROM ts)::bigint || '|' || value::text || '|' || qc, ','
                               ORDER BY series_id, ts)) AS sum
         FROM obs GROUP BY 1 ORDER BY 1`,
      );
      return Object.fromEntries(rows.map((r) => [r.part, r.sum]));
    },
    async count(table) {
      const { rows } = await t.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      return rows[0]?.n ?? 0;
    },
    async seriesId(key) {
      const { rows } = await t.admin.query<{ id: number }>('SELECT id FROM series WHERE provider_key = $1', [key]);
      if (rows[0] === undefined) throw new Error(`no series ${key}`);
      return rows[0].id;
    },
    async close() {
      await Promise.allSettled(opened.map((d) => d.close()));
      await t.drop();
      rmSync(raw, { recursive: true, force: true });
    },
  };
}

export const EMMERICH_W = '9598e4cb-0849-401e-bba0-689234b27644/W';
export const KAUB_W = '1d26e504-7f9e-480a-b52c-5932be6549ab/W';
export const RUHRWEHR_W = '12a3037f-cbf3-49d3-8da5-77fb38730bba/W';
export const SERIES_URL = (key: string) =>
  `https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/${key}/measurements.json?start=PT6H`;

/** A measurements.json body. */
export const measurements = (...points: [string, number][]) =>
  Buffer.from(JSON.stringify(points.map(([timestamp, value]) => ({ timestamp, value }))));
