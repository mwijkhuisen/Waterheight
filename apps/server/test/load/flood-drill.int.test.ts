import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dayOf, type StaticStations } from '@rws/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildFixtureArchive,
  buildFrChFixtureArchive,
  buildNlFixtureArchive,
  buildNlForecastFixtureArchive,
  buildNrwLuFixtureArchive,
  buildP7aFixtureArchive,
} from '../../../../scripts/fixture-archive.ts';
import { writeDrill } from '../../../../scripts/flood-drill.ts';
import { StaticCache } from '../../src/api/states.ts';
import { ArchiveReader } from '../../src/archive/reader.ts';
import { attributionRows } from '../../src/attribution.ts';
import { type Db, type DbConfig, dbConfig, openDb } from '../../src/db/pool.ts';
import { syncOwnerCanary } from '../../src/load/canary.ts';
import { Loader } from '../../src/load/pipeline.ts';
import { readRegistry, syncRegistry } from '../../src/load/registry-sync.ts';
import { vigicruesSections } from '../../src/load/tables.ts';
import type { RenderCtx } from '../../src/publish/cycle.ts';
import { RENDERERS } from '../../src/publish/render/index.ts';
import { createTestDb, type LoginRole, type TestDb } from '../db/testdb.ts';
import { latestUpsertSql, obsInsertSql } from '../e2e/seed.ts';

// The flood drill end to end, short of Docker (P12a, issue #27): the real loader, the real publishers' renderers and
// the real deploy/tests/e2e/flood-check.mjs. The archive is the one run.sh builds (every fixture of
// scripts/fixture-archive.ts), the registry is the drill's (deploy/tests/flood/setup.sh: station 2020 public), the
// observations are the load test's seed (the latest.json of a series needs a value), and the drill is written in its
// two phases. What flood-check.mjs reads is what the renderers wrote: it passes on the open phase, fails on the closed
// check of the same files and the other way round, so the check is neither vacuous nor blind.

const ROOT = new URL('../../../../', import.meta.url);
const NOW = Date.parse('2026-10-12T10:00:00Z');
/** The publishers' clock: 12 minutes after the drill clock, so that the 10-minute bucket is the one after it. */
const RENDER = NOW + 12 * 60_000;
const FLOOD_CHECK = fileURLToPath(new URL('deploy/tests/e2e/flood-check.mjs', ROOT));

const tmp: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'flood-int-'));
  tmp.push(d);
  return d;
};

let t: TestDb;
const opened: Db[] = [];
/** What a loader says when a class or a warning changes: the drill changes both, by design. */
const CHANGES = new Set(['warning_changed', 'class_changed']);
const alerts: { code: string; fields: Record<string, string | number> }[] = [];
let raw: string;
let loader: Loader;
let pub: Db;
let own: Db;

const dbAs = (role: LoginRole, max = 2): Db => {
  const db = openDb(dbConfig({ DATABASE_URL: t.urlFor(role) }, role) as DbConfig, { max });
  opened.push(db);
  return db;
};
type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
const q = async (text: string, args: unknown[] = []): Promise<Row[]> => (await t.admin.query(text, args)).rows;

beforeAll(async () => {
  // The drill's registry, written by the script run.sh calls.
  const registry = join(dir(), 'flood');
  const setup = spawnSync(
    fileURLToPath(new URL('deploy/tests/flood/setup.sh', ROOT)),
    [registry, fileURLToPath(ROOT)],
    {
      encoding: 'utf8',
    },
  );
  expect(setup.status, setup.stderr).toBe(0);

  t = await createTestDb();
  const migrator = dbAs('rws_migrator', 1);
  await syncRegistry(migrator.db, readRegistry(pathToFileURL(`${registry}/registry/`)));
  await migrator.db.transaction().execute((tx) => syncOwnerCanary(tx));

  raw = dir();
  const reader = new ArchiveReader(raw);
  loader = new Loader({
    db: dbAs('rws_load').db,
    reader,
    alert: (code, fields = {}) => alerts.push({ code, fields }),
    now: () => new Date(RENDER),
  });
  pub = dbAs('rws_publish');
  own = dbAs('rws_owner_api');
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(opened.map((d) => d.close()));
  await t?.drop();
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** run.sh's archive (scripts/fixture-archive.ts main), loaded in one tick. */
async function loadBase(): Promise<number> {
  const lines = [
    ...(await buildFixtureArchive(raw)),
    ...(await buildNlFixtureArchive(raw)),
    ...(await buildNlForecastFixtureArchive(raw)),
    ...(await buildFrChFixtureArchive(raw)),
    ...(await buildNrwLuFixtureArchive(raw)),
    ...(await buildP7aFixtureArchive(raw, new Set(['de-1-meta', 'ch-1-lindas-lake', 'ch-2-pq-relative']))),
  ];
  const done = await loader.tick();
  expect(done.lines).toBe(lines.length);
  return lines.length;
}

/** Every public primary series gets a value in the last 3 hours (the load test's seed, scripts/seed-loadtest.ts). */
async function seed(): Promise<void> {
  const from = new Date(RENDER - 3 * 3_600_000).toISOString().replace('.000Z', 'Z');
  const to = new Date(RENDER).toISOString().replace('.000Z', 'Z');
  await t.admin.query(`SELECT ensure_partitions('${from}'::timestamptz, '${to}'::timestamptz)`);
  await t.admin.query(obsInsertSql({ from, to }));
  await t.admin.query(latestUpsertSql(from, to));
}

/** The files of both publishers, as the cycle writes them, in <root>/{public,owner}/v1. */
async function render(root: string): Promise<void> {
  for (const family of ['public', 'owner'] as const) {
    const db = family === 'public' ? pub : own;
    const c: RenderCtx = {
      db: db.db,
      family,
      now: RENDER,
      window: { dataEpochMs: Date.parse('2026-09-01T00:00:00Z'), displayStartMs: Date.parse('2026-10-01T00:00:00Z') },
      build: 'dev',
      sections: vigicruesSections(),
      cache: new StaticCache(60_000, () => RENDER),
      inputs: undefined,
      attribution: await attributionRows(db.db, family),
    };
    const put = (rel: string, body: unknown) => {
      const path = join(root, family, 'v1', rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(body));
    };
    const stations = (await RENDERERS.stations(c)) as StaticStations;
    put('stations.json', stations);
    put('latest.json', (await RENDERERS.latest(c, stations)).body);
    put('warnings/latest.geojson', await RENDERERS.warnings(c, null));
    put('warnings/today.json', await RENDERERS.warnings(c, dayOf(RENDER)));
    put('forecast/latest.json', await RENDERERS.forecast(c));
    put('sources.json', await RENDERERS.sources(c));
  }
  copyFileSync(fileURLToPath(new URL('deploy/tests/flood/expected.json', ROOT)), join(root, 'expected.json'));
}

function floodCheck(root: string, phase: 'open' | 'closed'): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [FLOOD_CHECK, phase], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', FLOOD_ROOT: root, DRILL_NOW: new Date(NOW).toISOString(), FLOOD_WAIT_S: '0' },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const fails = (out: string) => out.split('\n').filter((l) => l.startsWith('FAIL'));

describe('the flood drill through the loader, the renderers and flood-check.mjs', { timeout: 600_000 }, () => {
  const open = dir();
  const closed = dir();

  it('the base archive of run.sh loads, with only the alerts the P7 fixtures raise', async () => {
    await loadBase();
    await seed();
    expect(await q("SELECT 1 FROM ingest_batch WHERE parse_status <> 'ok'")).toEqual([]);
    expect(new Set(alerts.map((a) => a.code))).toEqual(new Set(['warning_changed']));
    alerts.length = 0;
  });

  it('the main phase loads whole: nothing quarantined, nothing skipped, no alert but the classes and warnings that changed', async () => {
    const lines = await writeDrill({ rawDir: raw, now: NOW, phase: 'main' });
    expect(await loader.tick()).toEqual({ lines: lines.length, loaded: lines.length });
    const batches = await q(
      `SELECT source_id, spec_id, parse_status, error FROM ingest_batch WHERE fetched_at >= $1 ORDER BY id`,
      [new Date(NOW - 1000)],
    );
    expect(batches).toHaveLength(9);
    expect(batches.every((b) => b.parse_status === 'ok')).toBe(true);
    expect(alerts.filter((a) => !CHANGES.has(a.code))).toEqual([]);
  });

  it('the Nord alert is open and every area and station is where expected.json says (flood-check.mjs open passes)', async () => {
    await render(open);
    const r = floodCheck(open, 'open');
    expect(r.out).toContain('PASS flood-check-open');
    expect([r.status, fails(r.out)]).toEqual([0, []]);
    // Not vacuous: the same files fail the check of the closed phase, for the Nord zone and nothing else.
    const late = floodCheck(open, 'closed');
    expect(late.status).toBe(1);
    expect(fails(late.out).join('\n')).toMatch(/warnings\/latest\.geojson/);
    expect(late.out).toMatch(/Nord du Luxembourg/);
    expect(late.out).not.toMatch(/FAIL forecast\/latest\.json/);
  });

  it('the CH-4 storm run is in the public forecast, the DE-2 run in the owner one only, the canary in the owner tree only', async () => {
    const pubForecast = JSON.parse(readFileSync(join(open, 'public', 'v1', 'forecast', 'latest.json'), 'utf8')) as {
      runs: { source: string }[];
    };
    const ownForecast = JSON.parse(readFileSync(join(open, 'owner', 'v1', 'forecast', 'latest.json'), 'utf8')) as {
      runs: { source: string }[];
    };
    expect(pubForecast.runs.map((r) => r.source)).toContain('CH-4');
    expect(pubForecast.runs.map((r) => r.source)).not.toContain('DE-2');
    expect(ownForecast.runs.map((r) => r.source)).toContain('DE-2');
    expect(ownForecast.runs.map((r) => r.source)).toContain('CH-4');
  });

  it('the cancel phase closes the Nord alert and the TEST message stores nothing (flood-check.mjs closed passes)', async () => {
    const before = await q("SELECT count(*)::int AS n FROM warning_area WHERE source_id = 'LU-5'");
    const lines = await writeDrill({ rawDir: raw, now: NOW, phase: 'cancel', fetchedAt: NOW + 120_000 });
    expect(await loader.tick()).toEqual({ lines: lines.length, loaded: lines.length });
    expect(alerts.filter((a) => !CHANGES.has(a.code))).toEqual([]);
    // The Cancel ended the drill's Nord row (the recorded ones of 2025 and 2026 are older and untouched), the TEST added none.
    const nord = await q(
      `SELECT lower(valid) AS lo, upper(valid) AS hi FROM warning_area
       WHERE source_id = 'LU-5' AND area_key = 'Nord du Luxembourg' ORDER BY lower(valid) DESC LIMIT 1`,
    );
    expect(iso(nord[0]?.lo)).toBe('2026-10-12T01:00:05.000Z');
    expect(iso(nord[0]?.hi)).toBe('2026-10-12T09:49:48.000Z');
    expect(await q("SELECT count(*)::int AS n FROM warning_area WHERE source_id = 'LU-5'")).toEqual(before);
    const sud = await q(
      `SELECT upper(valid) AS hi FROM warning_area WHERE source_id = 'LU-5' AND area_key = 'Sud du Luxembourg'
       ORDER BY lower(valid) DESC LIMIT 1`,
    );
    expect(iso(sud[0]?.hi)).toBe('2026-10-12T19:44:58.000Z');

    await render(closed);
    const r = floodCheck(closed, 'closed');
    expect([r.status, fails(r.out)]).toEqual([0, []]);
    expect(r.out).toMatch(/^PASS flood-check$/m);
    // The other way round: the Nord alert is gone, so the check of the open phase fails.
    const early = floodCheck(closed, 'open');
    expect(early.status).toBe(1);
    expect(early.out).toMatch(/Nord du Luxembourg: not in the file/);
  });

  it('the checks see a broken drill: a CH-4 run that is not there, a DE-2 run in a public file, a canary in a public file', async () => {
    const root = dir();
    await render(root);
    const pubForecast = join(root, 'public', 'v1', 'forecast', 'latest.json');
    const doc = JSON.parse(readFileSync(pubForecast, 'utf8')) as { runs: { source: string }[] };
    writeFileSync(pubForecast, JSON.stringify({ ...doc, runs: doc.runs.filter((r) => r.source !== 'CH-4') }));
    writeFileSync(join(root, 'public', 'v1', 'sources.json'), '{"sources":[{"id":"DE-2"}]}');
    writeFileSync(join(root, 'public', 'v1', 'x.json'), '{"v":777777.75}');
    const r = floodCheck(root, 'closed');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL forecast\/latest\.json: the CH-4 storm run/);
    expect(r.out).toMatch(/DE-2 is named in a public file/);
    expect(r.out).toMatch(/a public file holds the canary/);
  });
});
