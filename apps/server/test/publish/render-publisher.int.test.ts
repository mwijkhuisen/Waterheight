import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANARIES,
  FramesFile,
  floorBucket,
  LatestFile,
  SnapshotFile,
  StaticForecastLatest,
  StaticMeta,
  StaticStations,
  StationRecent,
  toSnapshot,
} from '@rws/contracts';
import {
  OwnerLatestFile,
  OwnerSnapshotFile,
  OwnerStaticForecastLatest,
  OwnerStaticMeta,
  OwnerStaticStations,
  OwnerStationRecent,
} from '@rws/contracts/static-owner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSnapshot } from '../../src/api/data.ts';
import { StaticCache } from '../../src/api/states.ts';
import { attributionRows } from '../../src/attribution.ts';
import type { ChannelAudience } from '../../src/db/audience.ts';
import { publishTail } from '../../src/load/migrate.ts';
import { vigicruesSections } from '../../src/load/tables.ts';
import type { RenderCtx } from '../../src/publish/cycle.ts';
import { publishOnce } from '../../src/publish/index.ts';
import { renderFrames } from '../../src/publish/render/frames.ts';
import { RENDERERS } from '../../src/publish/render/index.ts';
import { renderLatest } from '../../src/publish/render/latest.ts';
import { renderMeta } from '../../src/publish/render/meta.ts';
import { renderStation } from '../../src/publish/render/series.ts';
import { renderSnapshot } from '../../src/publish/render/snapshot.ts';
import { renderStations, seriesHash } from '../../src/publish/render/stations.ts';
import { type Harness, harness } from '../load/harness.ts';

// P9a (S1): the six renderers against the real views, public and owner: contracts, equality with the API's /snapshot,
// the settled file as a pure function of the data, latest.json's order, hash and deltas, the canaries, and the cycle.

const NOW = Date.parse('2026-10-04T12:05:00Z');
const STEP = 600_000;
const BASE = Date.parse('2026-10-01T00:00:00Z');
const K_NOW = (floorBucket(NOW) - BASE) / STEP; // the step index of 12:00 on 10-04
const iso = (ms: number) => new Date(ms).toISOString();
const WINDOW = { dataEpochMs: BASE - 86_400_000, displayStartMs: BASE };

let h: Harness;
let ids: { a: number; b: number; c: number; withheld: number };
let stationA: string;
let canary: number;

async function seed() {
  const q = (text: string, values: unknown[] = []) => h.t.admin.query(text, values);
  await q(`UPDATE app_meta SET value = '"2026-10-01T00:00:00Z"' WHERE key = 'display_start'`);
  await q(`SELECT ensure_partitions('2026-09-30'::timestamptz, '2026-10-06'::timestamptz)`);
  const { rows } = await q(
    `SELECT s.id, s.station_id FROM series s WHERE s.source_id = 'NL-1' AND s.active AND s.role = 'primary'
       AND NOT EXISTS (SELECT 1 FROM series o WHERE o.station_id = s.station_id AND o.id <> s.id)
     ORDER BY s.id LIMIT 3`,
  );
  await q(`INSERT INTO station (id, name, country, tier) VALUES ('nl.canary.withheld', 'withheld canary', 'NL', 2)`);
  const w = await q(
    `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                         native_step, expected_step, staleness_limit, role, audience)
     VALUES ('nl.canary.withheld', 'NL-1', 'H', 'stage', 'canary-withheld', 'cm', 1, 'LOCAL', '15 min', '15 min',
             '45 min', 'primary', 'off') RETURNING id`,
  );
  ids = { a: rows[0].id, b: rows[1].id, c: rows[2].id, withheld: w.rows[0].id };
  stationA = rows[0].station_id;
  // value = 100 + k at BASE + k steps: Δh over 1 h is 6 and over 24 h is 144 wherever both ends exist.
  const obs = (series: number, from: number, to: number, mul = 1) =>
    q(
      `INSERT INTO obs (series_id, ts, value, qc, batch_id)
       SELECT $1, $2::timestamptz + k * interval '10 minutes', 100 + k * $5, 0, 0 FROM generate_series($3::int, $4::int) k`,
      [series, iso(BASE), from, to, mul],
    );
  await obs(ids.a, 0, 504);
  await obs(ids.b, 490, 504);
  // Series c: its newest value is 64 steps (38,400 s) before the bucket, far past the 45-minute limit (KG-233).
  await obs(ids.c, 0, 440);
  // The loader keeps obs_latest; this seed writes obs directly, so it writes the newest point itself.
  await q(`INSERT INTO obs_latest (series_id, ts, value, qc, batch_id) VALUES ($1, $2, 540, 0, 0)`, [
    ids.c,
    iso(BASE + 440 * STEP),
  ]);
  await q(
    `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     VALUES ($1, $2, ${CANARIES.withheld.value}, 0, 0)`,
    [ids.withheld, iso(floorBucket(NOW) - 600_000)],
  );
  // The hourly rollup of series a, with a gap at 10:00 on 10-01.
  await q(
    `INSERT INTO obs_1h (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
     SELECT $1, $2::timestamptz + h * interval '1 hour', 1, 1, 1, 100 + h * 6, 6, 0 FROM generate_series(0, 83) h WHERE h <> 10`,
    [ids.a, iso(BASE)],
  );
  await q(
    `INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, valid, basis_label) VALUES
       ($1, 'NL-1', 'MNW', 20, 'cm', 'statistical', tstzrange('2020-01-01', NULL), 'TEST MNW'),
       ($1, 'NL-1', 'MHW', 700, 'cm', 'statistical', tstzrange('2020-01-01', NULL), 'TEST MHW')`,
    [ids.a],
  );
  const run = await q(
    `INSERT INTO forecast_run (series_id, source_id, issued_at, first_valid, last_valid, fetched_at, content_hash, kind)
     VALUES ($1, 'NL-1', $2, $2, $3, $2, decode(md5('s1'), 'hex'), 'deterministic') RETURNING id`,
    [ids.a, iso(NOW - 3_600_000), iso(NOW + 2 * 86_400_000)],
  );
  await q(
    `INSERT INTO forecast_value (run_id, valid_ts, value)
     SELECT $1, $2::timestamptz + h * interval '1 hour', 150 + h FROM generate_series(0, 6) h`,
    [run.rows[0].id, iso(Math.floor(NOW / 3_600_000) * 3_600_000)],
  );
  const mig = h.dbAs('rws_migrator', 1);
  await publishTail(mig.db, new Date(NOW));
  const c = await q(`SELECT id FROM series WHERE provider_key = 'owner-canary'`);
  canary = c.rows[0].id;
}

const dbs = new Map<ChannelAudience, ReturnType<Harness['dbAs']>>();
async function ctx(family: ChannelAudience, now = NOW): Promise<RenderCtx> {
  let db = dbs.get(family);
  if (db === undefined) {
    db = h.dbAs(family === 'public' ? 'rws_publish' : 'rws_owner_api');
    dbs.set(family, db);
  }
  return {
    db: db.db,
    family,
    now,
    window: WINDOW,
    build: 'dev',
    sections: vigicruesSections(),
    cache: new StaticCache(60_000, () => now),
    inputs: undefined,
    attribution: await attributionRows(db.db, family),
  };
}

beforeAll(async () => {
  h = await harness();
  await seed();
}, 120_000);
afterAll(async () => {
  await h.close();
});

const T0 = floorBucket(NOW) - 2 * 3_600_000;
const TIMES = [T0, floorBucket(NOW), BASE + 6 * 3_600_000, BASE - 3_600_000];

describe('renderers', { timeout: 120_000 }, () => {
  for (const family of ['public', 'owner'] as const) {
    const [Snap, Latest, Stations, Meta, Recent] =
      family === 'public'
        ? [SnapshotFile, LatestFile, StaticStations, StaticMeta, StationRecent]
        : [OwnerSnapshotFile, OwnerLatestFile, OwnerStaticStations, OwnerStaticMeta, OwnerStationRecent];

    it(`${family}: every body parses with the family's contract`, async () => {
      const c = await ctx(family);
      const stations = Stations.parse(await renderStations(c));
      Latest.parse((await renderLatest(c, stations)).body);
      Snap.parse(await renderSnapshot(c, T0));
      Meta.parse(await renderMeta(c, { dayVersions: { '2026-10-01': 0 }, degraded: false, latestFrom: null }));
      Recent.parse(await renderStation(c, stationA));
      if (family === 'public') FramesFile.parse(await renderFrames(c, BASE, BASE + 86_400_000));
    });

    it(`${family}: toSnapshot(file) equals the API's snapshot`, async () => {
      const c = await ctx(family);
      for (const t of TIMES) {
        const file = Snap.parse(await renderSnapshot(c, t));
        const api = await readSnapshot(c.db, family, t, { now: NOW, sections: c.sections, cache: c.cache });
        expect(toSnapshot(file)).toEqual(api);
      }
      const file = Snap.parse(await renderSnapshot(c, T0));
      expect(file.series).toContain(ids.a);
      expect(file.series).not.toContain(ids.withheld);
      expect(file.bases.length).toBeGreaterThan(0);
    });
  }

  it('a settled file is a pure function of the data: the same bytes at two clocks', async () => {
    const t = BASE + 6 * 3_600_000;
    const a = JSON.stringify(await renderSnapshot(await ctx('public', NOW), t));
    const b = JSON.stringify(await renderSnapshot(await ctx('public', NOW + 9 * 86_400_000), t));
    expect(b).toBe(a);
    expect(a).not.toContain('generatedAt');
    expect(JSON.parse(a).attribution.every((x: { date: unknown }) => x.date === null)).toBe(true);
  });

  it('latest: stations.json order, its hash, and Δh from Q1', async () => {
    const c = await ctx('public');
    const stations = StaticStations.parse(await renderStations(c));
    const { body, latestFrom } = await renderLatest(c, stations);
    const file = LatestFile.parse(body);
    const order = stations.stations.flatMap((s) => s.series.map((x) => x.id));
    expect(stations.seriesHash).toBe(seriesHash(order));
    expect(file.seriesHash).toBe(stations.seriesHash);
    expect(file.series).toEqual(order.filter((id) => file.series.includes(id)));
    expect(file.t).toBe(iso(floorBucket(NOW)));
    expect(file.generatedAt).toBe(iso(NOW));
    expect(latestFrom).toBeNull();
    const at = (id: number) => file.series.indexOf(id);
    expect(file.value[at(ids.a)]).toBe(100 + K_NOW);
    expect(file.dh1[at(ids.a)]).toBe(6);
    expect(file.dh24[at(ids.a)]).toBe(144);
    expect(file.dh1[at(ids.b)]).toBe(6);
    expect(file.dh24[at(ids.b)]).toBeNull();
    expect(file.series).not.toContain(ids.withheld);
  });

  it('latest: a series past its limit is lapsed with the age of its newest value, never one with a value', async () => {
    const c = await ctx('public');
    const stations = StaticStations.parse(await renderStations(c));
    const file = LatestFile.parse((await renderLatest(c, stations)).body);
    expect(file.series).not.toContain(ids.c);
    expect(file.lapsed).toContain(ids.c);
    expect(file.lapsedAge[file.lapsed.indexOf(ids.c)]).toBe(38_400);
    // A registry series that never had an observation is lapsed with null; the series with a value are not listed.
    expect(file.lapsedAge).toContain(null);
    expect(file.lapsed).not.toContain(ids.a);
    expect(file.lapsed).not.toContain(ids.b);
    expect(file.lapsed).not.toContain(ids.withheld);
    const order = stations.stations.flatMap((s) => s.series.map((x) => x.id));
    expect(file.lapsed).toEqual(order.filter((id) => file.lapsed.includes(id)));
  });

  it('latest, owner family: lapsed through its own latest view, the owner canary with a value never lapsed', async () => {
    const c = await ctx('owner');
    const stations = OwnerStaticStations.parse(await renderStations(c));
    const file = OwnerLatestFile.parse((await renderLatest(c, stations)).body);
    expect(file.lapsed).toContain(ids.c);
    expect(file.lapsedAge[file.lapsed.indexOf(ids.c)]).toBe(38_400);
    expect(file.series).toContain(canary);
    expect(file.lapsed).not.toContain(canary);
    expect(file.lapsed).not.toContain(ids.withheld);
  });

  it('latest: a newest point after the bucket gives age 0, never a negative age', async () => {
    const c = await ctx('public');
    const stations = StaticStations.parse(await renderStations(c));
    const before = LatestFile.parse((await renderLatest(c, stations)).body);
    // A series that never had a value; its newest point is now at the clock, five minutes after the bucket.
    const d = before.lapsed[before.lapsedAge.indexOf(null)] as number;
    expect(d).toBeDefined();
    await h.t.admin.query(`INSERT INTO obs_latest (series_id, ts, value, qc, batch_id) VALUES ($1, $2, 1, 0, 0)`, [
      d,
      iso(NOW),
    ]);
    try {
      const file = LatestFile.parse((await renderLatest(c, stations)).body);
      expect(file.series).not.toContain(d);
      expect(file.lapsedAge[file.lapsed.indexOf(d)]).toBe(0);
    } finally {
      await h.t.admin.query(`DELETE FROM obs_latest WHERE series_id = $1`, [d]);
    }
  });

  it('frames: one row per series with a value, null where an hour has none', async () => {
    const f = FramesFile.parse(await renderFrames(await ctx('public'), BASE, BASE + 86_400_000));
    expect(f.series).toEqual([ids.a]);
    expect(f.vlast[0]).toHaveLength(24);
    expect(f.vlast[0]?.[9]).toBe(154);
    expect(f.vlast[0]?.[10]).toBeNull();
    expect(f.stepSeconds).toBe(3600);
    expect(
      FramesFile.parse(
        await renderFrames(await ctx('public'), BASE + 90 * 86_400_000, BASE + 90 * 86_400_000 + 7_200_000),
      ).series,
    ).toEqual([]);
  });

  it('station: raw observations, the run and the references valid now', async () => {
    const c = await ctx('public');
    const r = StationRecent.parse(await renderStation(c, stationA));
    expect(r.from).toBe(iso(NOW - 7 * 86_400_000));
    expect(r.to).toBe(iso(NOW));
    const s = r.series[0];
    expect(s?.id).toBe(ids.a);
    expect(s?.ts.length).toBe(505);
    expect([...(s?.ts ?? [])].sort()).toEqual(s?.ts);
    expect(s?.value.at(-1)).toBe(100 + 504);
    expect(s?.run?.source).toBe('NL-1');
    expect(s?.references.map((x) => x.label)).toEqual(expect.arrayContaining(['TEST MHW', 'TEST MNW']));
    expect(r.attribution.every((a) => a.date === null)).toBe(true);
    const other = StationRecent.parse(
      await renderStation(c, (await renderStations(c)).stations.find((x) => x.series[0]?.id === ids.b)?.id as string),
    );
    expect(other.series[0]?.run).toBeNull();
    expect(other.series[0]?.references.some((x) => x.label?.startsWith('TEST'))).toBe(false);
  });

  it('meta: the API meta plus the static fields, attribution of its sources', async () => {
    const m = StaticMeta.parse(
      await renderMeta(await ctx('public'), { dayVersions: { '2026-10-01': 0 }, degraded: true, latestFrom: iso(NOW) }),
    );
    expect(m).toMatchObject({ schemaVersion: 1, degraded: true, latestFrom: iso(NOW), generatedAt: iso(NOW) });
    expect(m.dayVersions).toEqual({ '2026-10-01': 0 });
    expect(new Set(m.attribution.map((a) => a.source))).toEqual(
      new Set(m.sources.filter((s) => s.attribution.length > 0).map((s) => s.id)),
    );
  });

  it('the owner canary is in the owner bodies and in no public body; the withheld canary is nowhere', async () => {
    const own = await ctx('owner');
    const pub = await ctx('public');
    const ownerStations = OwnerStaticStations.parse(await renderStations(own));
    const publicStations = StaticStations.parse(await renderStations(pub));
    const bodies = async (c: RenderCtx, stations: typeof ownerStations) => [
      JSON.stringify(await renderSnapshot(c, T0)),
      JSON.stringify((await renderLatest(c, stations)).body),
      JSON.stringify(stations),
      JSON.stringify(await renderMeta(c, { dayVersions: {}, degraded: false, latestFrom: null })),
      ...(c.family === 'public' ? [JSON.stringify(await renderFrames(c, BASE, BASE + 86_400_000))] : []),
    ];
    const ownerBodies = await bodies(own, ownerStations);
    expect(ownerBodies[0]).toContain(CANARIES.owner.real);
    expect(ownerBodies[1]).toContain(CANARIES.owner.real);
    expect(ownerStations.stations.some((s) => s.series.some((x) => x.id === canary))).toBe(true);
    const station = ownerStations.stations.find((s) => s.series.some((x) => x.id === canary));
    ownerBodies.push(JSON.stringify(await renderStation(own, station?.id as string)));
    expect(ownerBodies.at(-1)).toContain(CANARIES.owner.real);
    const publicBodies = [...(await bodies(pub, publicStations)), JSON.stringify(await renderStation(pub, stationA))];
    for (const text of publicBodies)
      for (const s of [CANARIES.owner.text, CANARIES.owner.real, 'CANARY-OWNER', 'nl.canary.owner'])
        expect(text).not.toContain(s);
    for (const text of [...ownerBodies, ...publicBodies])
      for (const s of [CANARIES.withheld.text, CANARIES.withheld.real]) expect(text).not.toContain(s);
  });
});

describe('publishOnce with the real renderers', { timeout: 300_000 }, () => {
  for (const family of ['public', 'owner'] as const) {
    it(`${family}: writes files that equal the API's snapshot`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rws-s1-'));
      try {
        const db = h.dbAs(family === 'public' ? 'rws_publish' : 'rws_owner_api', 3);
        await publishOnce(db.db, family, dir, { now: NOW, render: RENDERERS });
        const read = (rel: string) => JSON.parse(readFileSync(join(dir, 'v1', rel), 'utf8'));
        const meta = (family === 'public' ? StaticMeta : OwnerStaticMeta).parse(read('meta.json'));
        expect(meta.latestFrom).toBeNull();
        const latest = (family === 'public' ? LatestFile : OwnerLatestFile).parse(read('latest.json'));
        const stations = (family === 'public' ? StaticStations : OwnerStaticStations).parse(read('stations.json'));
        expect(latest.seriesHash).toBe(stations.seriesHash);
        const c = await ctx(family);
        const t = floorBucket(NOW) - 3_600_000;
        const rel = `recent/${iso(t).slice(0, 10)}/${iso(t).slice(11, 16).replace(':', '')}.json`;
        const api = await readSnapshot(c.db, family, t, { now: NOW, sections: c.sections, cache: c.cache });
        expect(toSnapshot(read(rel))).toEqual(api);
        expect(readdirSync(join(dir, 'v1/series'))).toContain(stationA);
        // forecast/latest.json: the owner canary's run in the owner file only.
        const forecast = (family === 'public' ? StaticForecastLatest : OwnerStaticForecastLatest).parse(
          read('forecast/latest.json'),
        );
        expect(forecast.runs.some((r) => r.source === 'CANARY-OWNER')).toBe(family === 'owner');
        for (const a of forecast.attribution) expect(forecast.runs.some((r) => r.source === a.source)).toBe(true);
        if (family === 'public') {
          expect(meta.dayVersions).toEqual({});
          const settled = read('settled/2026-10-01/v1/0600.json');
          expect(toSnapshot(settled)).toEqual(
            await readSnapshot(c.db, family, BASE + 6 * 3_600_000, { now: NOW, sections: c.sections, cache: c.cache }),
          );
          FramesFile.parse(read('frames/2026-10-01/v1.json'));
          FramesFile.parse(read('frames/recent.json'));
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('history export (§9 C5)', { timeout: 120_000 }, () => {
  it('only latest.json and the station list carry a series without history_export, and only inside its window', async () => {
    await h.t.admin.query(`UPDATE series SET lic_override = '{"history_export": false}' WHERE id = $1`, [ids.b]);
    await h.t.admin.query(`UPDATE source SET history_window = '240 hours' WHERE id = 'NL-1'`);
    const c = await ctx('public');
    const stations = StaticStations.parse(await renderStations(c));
    expect(stations.stations.flatMap((s) => s.series.map((x) => x.id))).toContain(ids.b);
    const { body } = await renderLatest(c, stations);
    expect(LatestFile.parse(body).series).toContain(ids.b);
    expect(SnapshotFile.parse(await renderSnapshot(c, floorBucket(NOW) - 3_600_000)).series).not.toContain(ids.b);
    const stationB = stations.stations.find((s) => s.series.some((x) => x.id === ids.b))?.id as string;
    expect(StationRecent.parse(await renderStation(c, stationB)).series).toEqual([]);
    // A window no longer than staleness + 1 h: not even latest.json, nor stations.json.
    await h.t.admin.query(`UPDATE source SET history_window = '30 minutes' WHERE id = 'NL-1'`);
    const narrow = StaticStations.parse(await renderStations(await ctx('public')));
    expect(narrow.stations.flatMap((s) => s.series.map((x) => x.id))).not.toContain(ids.b);
  });
});
