import { QC } from '@rws/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bareLine, buildFrChFixtureArchive, recorded, writePayload } from '../../../../scripts/fixture-archive.ts';
import { readMeta } from '../../src/api/data.ts';
import { loadRegistry } from '../../src/capture/specs.ts';
import { VIEWS } from '../../src/db/audience.ts';
import { FILLED_BY, type LoadAdapter } from '../../src/load/adapters.ts';
import { computeHealth, findCoverage, type HealthInputs } from '../../src/load/health.ts';
import { replay } from '../../src/load/replay.ts';
import { cadences } from '../../src/load/run.ts';
import { type Harness, harness } from './harness.ts';

// FR-1, FR-3, CH-1, CH-2 and CH-3 through the loader (issue #20, P5a), on the
// recorded and archive-exported fixtures: every payload loads, the two 206
// pages of one Hub'Eau walk meet, mirrors and twins never reach a public view,
// the §0.6 Belgian points do, the FR-3 and CH-3 seeds only fill gaps (in
// either load order, without a revision), a replay writes nothing, and health
// shows the capture interval and the coverage since the seed.

let h: Harness;
const AFTER = new Date('2026-10-01T00:00:00Z');
const SOURCES = ['FR-1', 'FR-3', 'CH-1', 'CH-2', 'CH-3'] as const;
const deps = (x: Harness) => ({
  db: x.load.db,
  reader: x.reader,
  alert: (code: string, fields: Record<string, string | number> = {}) => x.alerts.push({ code, fields }),
  now: () => AFTER,
});

/** The stored rows of one series (by source and key), in time order, as plain values. */
async function rows(x: Harness, source: string, key: string) {
  const { rows: r } = await x.t.admin.query<{ ts: Date; value: number; qc: number }>(
    `SELECT o.ts, o.value, o.qc FROM obs o JOIN series s ON s.id = o.series_id
     WHERE s.source_id = $1 AND s.provider_key = $2 ORDER BY o.ts`,
    [source, key],
  );
  return r;
}

/** Every stored table a load order could change, keyed by source and provider key (never by id). */
async function state(x: Harness) {
  const q = async (sql: string) => (await x.t.admin.query(sql)).rows;
  const by = `JOIN series s ON s.id = t.series_id`;
  return {
    obs: await q(`SELECT s.source_id, s.provider_key, t.ts, t.value, t.qc FROM obs t ${by} ORDER BY 1, 2, 3`),
    latest: await q(`SELECT s.source_id, s.provider_key, t.ts, t.value, t.qc FROM obs_latest t ${by} ORDER BY 1, 2`),
    h1: await q(
      `SELECT s.source_id, s.provider_key, t.bucket, t.vmin, t.vmax, t.vavg, t.vlast, t.n, t.qc_or FROM obs_1h t ${by} ORDER BY 1, 2, 3`,
    ),
    d1: await q(
      `SELECT s.source_id, s.provider_key, t.bucket, t.vmin, t.vmax, t.vavg, t.vlast, t.n, t.qc_or FROM obs_1d t ${by} ORDER BY 1, 2, 3`,
    ),
    revisions: await q('SELECT count(*)::int AS n FROM obs_revision'),
  };
}

async function put(x: Harness, source: string, spec: string, name: string, variant: string, extra = {}) {
  const f = recorded(name, source);
  await writePayload(x.archive, { source, spec, variant, at: f.at, body: f.body, url: f.url, ...extra });
}

beforeAll(async () => {
  h = await harness();
});

afterAll(async () => {
  await h.close();
});

describe('the FR-1, FR-3, CH-1, CH-2 and CH-3 fixtures', () => {
  it('load: every payload ok, nothing quarantined, no alert', async () => {
    const lines = await buildFrChFixtureArchive(h.raw);
    const r = await h.loader({ now: AFTER }).tick();
    expect(r).toEqual({ lines: lines.length, loaded: lines.length });
    expect(h.alerts).toEqual([]);
    const { rows: batches } = await h.t.admin.query(
      `SELECT source_id, parse_status, count(*)::int AS n FROM ingest_batch GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    expect(batches).toEqual([
      { source_id: 'CH-1', parse_status: 'ok', n: 2 },
      { source_id: 'CH-2', parse_status: 'ok', n: 1 },
      { source_id: 'CH-3', parse_status: 'ok', n: 3 },
      { source_id: 'FR-1', parse_status: 'ok', n: 5 },
      { source_id: 'FR-3', parse_status: 'ok', n: 3 },
    ]);
  });

  it('the two 206 pages of one walk both load and meet: 491 mm is 49.1 cm (A420063002 H, 2026-09-01)', async () => {
    const r = await rows(h, 'FR-1', 'A420063002/H');
    const at = (iso: string) => r.find((x) => x.ts.toISOString() === iso);
    // The end of page 1 (08:40Z–08:30Z) and the start of page 2 (08:30Z–08:25Z): page 2 goes on with the row after
    // page 1's cursor row (A211030001 H 08:30Z), so the two pages meet at 08:30Z.
    expect(at('2026-09-01T08:35:00.000Z')?.value).toBeCloseTo(49.1, 5);
    expect(at('2026-09-01T08:30:00.000Z')?.value).toBeCloseTo(49.1, 5);
    expect(at('2026-09-01T08:25:00.000Z')?.value).toBeCloseTo(49.1, 5);
    for (const x of r) expect(x.qc & QC.RAW).toBe(QC.RAW);
  });

  it('keeps a negative Q with our range bit, and never a site-level row', async () => {
    const neg = (await rows(h, 'FR-1', 'E172751201/Q')).filter((x) => x.value < 0);
    expect(neg.length).toBeGreaterThan(0);
    for (const x of neg) expect(x.qc & QC.RANGE).toBe(QC.RANGE);
    const { rows: keys } = await h.t.admin.query(
      `SELECT count(*)::int AS n FROM series WHERE source_id = 'FR-1' AND provider_key NOT LIKE '_%/_'`,
    );
    expect(keys).toEqual([{ n: 0 }]);
  });

  it('stores the FR-1 gauge zeros as published, only on datums nothing converts (IGN69, NGF1884: D16)', async () => {
    const { rows: zeros } = await h.t.admin.query(
      `SELECT DISTINCT g.datum FROM gauge_zero g JOIN series s ON s.id = g.series_id WHERE s.source_id = 'FR-1'`,
    );
    expect(zeros.map((z) => z.datum).sort()).toEqual(['IGN69', 'NGF1884']);
  });

  it('keeps the latest of a station that comes twice (CH-1 2283) and declares relative gauges as stages', async () => {
    const latest = await rows(h, 'CH-1', '2283/W');
    expect(latest.map((x) => x.ts.toISOString())).toEqual(['2026-09-29T13:20:00.000Z']);
    const { rows: decl } = await h.t.admin.query(
      `SELECT value_kind, datum FROM series WHERE source_id = 'CH-1' AND provider_key = '2283/W'`,
    );
    expect(decl).toEqual([{ value_kind: 'stage', datum: 'LOCAL' }]);
  });

  it('publishes the §0.6 Belgian points and the FR/CH primaries; never a mirror or a twin (as rws_api)', async () => {
    const api = await h.t.connectAs('rws_api');
    const st = await api.query<{ id: string }>(`SELECT id FROM ${VIEWS.public.station}`);
    const ids = new Set(st.rows.map((r) => r.id));
    expect(ids.has('fr.sandre.E381126601')).toBe(true); // Lys at Menen, a Belgian partner
    expect(ids.has('ch.bafu.2289')).toBe(true); // Basel from CH-1
    for (const mirror of ['A021005050', 'A040000101', 'A060005050', 'A355005050', 'A375005050', 'A940000101'])
      expect(ids.has(`fr.sandre.${mirror}`), mirror).toBe(false);
    for (const id of ids) {
      expect(id.startsWith('fr.vigicrues.'), id).toBe(false);
      expect(id.startsWith('ch.bafu-pq.'), id).toBe(false);
    }
  });
});

describe('gap-fill (FR-3 → FR-1, CH-3 → CH-1)', () => {
  it('fills only where the source states no value, with the backfilled bit and no revision', async () => {
    const chooz = await rows(h, 'FR-1', 'B720000001/H');
    const own = chooz.filter((x) => (x.qc & QC.BACKFILLED) === 0);
    const fill = chooz.filter((x) => (x.qc & QC.BACKFILLED) !== 0);
    expect(own.length).toBeGreaterThan(0);
    expect(fill.length).toBeGreaterThan(own.length);
    // FR-1's own rows are the live page's (2026-09-29) and any of the walk's (2026-09-01): FR-3 never replaced one.
    expect(own.every((x) => ['2026-09-01', '2026-09-29'].includes(x.ts.toISOString().slice(0, 10)))).toBe(true);
    // The FR-3 twin series holds every Vigicrues value, without the bit.
    const twin = await rows(h, 'FR-3', 'B720000001/H');
    expect(twin.every((x) => (x.qc & QC.BACKFILLED) === 0)).toBe(true);
    expect(twin.length).toBe(own.length + fill.length - (await h.count('obs_revision')));
    expect(await h.count('obs_revision')).toBe(0);
    // CH-3 fills CH-1 on the 10-minute grid; the one CH-1 value of 2289 (2026-09-29T13:20Z) stays CH-1's.
    const basel = await rows(h, 'CH-1', '2289/W');
    expect(basel.find((x) => x.ts.toISOString() === '2026-09-29T13:20:00.000Z')?.qc).toBe(QC.RAW);
    expect(basel.filter((x) => (x.qc & QC.BACKFILLED) !== 0).length).toBeGreaterThan(250);
    expect(basel.every((x) => x.ts.getTime() % 600_000 === 0)).toBe(true);
  });

  it('gives the same rows, rollups and revisions in either load order', async () => {
    // The live page (2026-09-29 12:30Z–13:30Z) overlaps the Chooz FR-3 series (to 13:30Z) and is fetched after it.
    const own = { source: 'FR-1', spec: 'fr-1-obs', name: 'fr-1-obs', variant: 'default', extra: {} };
    const fill = { source: 'FR-3', spec: 'fr-3-obs', name: 'fr-3-obs', variant: 'B720000001/H', extra: {} };
    const chOwn = { source: 'CH-1', spec: 'ch-1-lindas', name: 'ch-1-lindas', variant: 'river', extra: {} };
    const chFill = { source: 'CH-3', spec: 'ch-3-40d', name: 'ch-3-40d-2289', variant: '2289', extra: {} };
    const states = [];
    for (const order of [
      [own, fill, chOwn, chFill],
      [fill, own, chFill, chOwn],
    ]) {
      const x = await harness();
      try {
        for (const f of order) {
          await put(x, f.source, f.spec, f.name, f.variant, f.extra);
          // One payload per tick: the order of loading is the order of writing.
          await x.loader({ now: AFTER }).tick();
        }
        expect(x.alerts).toEqual([]);
        states.push(await state(x));
      } finally {
        await x.close();
      }
    }
    expect(states[1]).toEqual(states[0]);
    expect(states[0]?.revisions).toEqual([{ n: 0 }]);
  }, 120_000);

  it('counts a fill row whose target is unknown, and drops one for a mirror, never quarantining the payload', async () => {
    const x = await harness();
    try {
      const adapters: Record<string, LoadAdapter> = {
        'FR-3': {
          version: 1,
          specs: {
            'fr-3-obs': {
              maxBytes: 1024,
              needsVariant: false,
              fill: 'FR-1',
              run: () => ({
                obs: [],
                gaugeZeros: [],
                dropped: {},
                unknown: 0,
                fill: [
                  { series: 'X000000000/H', ts: '2026-09-29T12:00:00.000Z', value: 1, qc: QC.RAW },
                  { series: 'A021005050/H', ts: '2026-09-29T12:00:00.000Z', value: 1, qc: QC.RAW },
                ],
              }),
            },
          },
        },
      };
      await writePayload(x.archive, {
        source: 'FR-3',
        spec: 'fr-3-obs',
        variant: 'X000000000/H',
        at: new Date('2026-09-29T13:00:00Z'),
        body: Buffer.from('{}'),
        url: 'https://www.vigicrues.gouv.fr/',
      });
      expect(await x.loader({ adapters, now: AFTER }).tick()).toEqual({ lines: 1, loaded: 1 });
      const { rows: b } = await x.t.admin.query('SELECT parse_status, n_rows, n_skipped FROM ingest_batch');
      expect(b).toEqual([{ parse_status: 'ok', n_rows: 0, n_skipped: 1 }]);
      expect(await x.count('obs')).toBe(0);
    } finally {
      await x.close();
    }
  }, 60_000);
});

describe('replay and health', () => {
  it('a replay of every source writes nothing, twice', async () => {
    const before = await state(h);
    for (let pass = 0; pass < 2; pass += 1) {
      for (const source of SOURCES) {
        const r = await replay(deps(h), { source, spec: null, from: '2026-09-01', to: '2026-12-31', dryRun: false });
        expect({ source, quarantined: r.quarantined, n_new: r.n_new, n_changed: r.n_changed }).toEqual({
          source,
          quarantined: 0,
          n_new: 0,
          n_changed: 0,
        });
      }
    }
    expect(await state(h)).toEqual(before);
  });

  it('shows the shortest capture interval per spec and the coverage since the seed', async () => {
    // Two CH-1 river runs ten minutes apart that brought nothing new (dup_of), and a lake run in between.
    for (const [variant, at] of [
      ['river', '2026-09-30T23:04:01Z'],
      ['lake', '2026-09-30T23:04:03Z'],
      ['river', '2026-09-30T23:14:00Z'],
    ] as const) {
      await h.archive.append(bareLine('CH-1', 'ch-1-lindas', new Date(at), { variant, dup_of: 'raw/CH-1/x' }));
    }
    await h.loader({ now: AFTER }).tick();
    const cadenceS = new Map([
      ['FR-1', 900],
      ['CH-1', 600],
    ]);
    await computeHealth(h.load.db, {
      cadenceS,
      lagP95Ms: new Map(),
      backlog: { files: 0, bytes: 0, age_s: null },
      badLines: 0,
      now: AFTER,
      coverage: await findCoverage(h.load.db, cadenceS, AFTER),
    });
    const { rows: d } = await h.t.admin.query<{ source_id: string; detail: Record<string, unknown> }>(
      `SELECT source_id, detail FROM source_health WHERE source_id IN ('FR-1', 'CH-1', 'CH-3') ORDER BY 1`,
    );
    const of = (id: string) => d.find((r) => r.source_id === id)?.detail ?? {};
    expect(of('CH-1').min_interval_s).toEqual([{ spec: 'ch-1-lindas', seconds: 599 }]);
    const coverage = of('FR-1').coverage as { ratio: number; series: number; from: string };
    expect(coverage.series).toBeGreaterThan(0);
    expect(coverage.ratio).toBeGreaterThan(0);
    expect(coverage.ratio).toBeLessThanOrEqual(1);
    expect(Date.parse(coverage.from)).toBeGreaterThanOrEqual(Date.parse('2026-08-24T00:00:00Z'));
  });

  it('keeps interval state only for a source the registry knows (review SR-4)', async () => {
    for (const at of ['2026-09-30T23:04:00Z', '2026-09-30T23:14:00Z'])
      await h.archive.append(bareLine('NL-99', 'nl-99-obs', new Date(at), { variant: 'default', status: 304 }));
    await h.loader({ now: AFTER }).tick();
    const { rows } = await h.t.admin.query<{ key: string }>(
      `SELECT key FROM app_meta WHERE key LIKE 'intervals:%' ORDER BY 1`,
    );
    expect(rows.map((r) => r.key)).toContain('intervals:CH-1');
    expect(rows.map((r) => r.key)).not.toContain('intervals:NL-99');
  });

  it('judges a seed-only source (a seed spec, no cron spec: CH-3) not on its fetch age, any other source on it (review SR-6)', async () => {
    const { source: cadenceS, seedOnly } = cadences(loadRegistry().specs);
    expect([...seedOnly]).toEqual(['CH-3']);
    // FR-3 has a seed spec and a cron spec (fr-3-twin): it is judged on its fetch age.
    expect(cadenceS.get('FR-3')).toBe(21_600);
    const inputs: HealthInputs = {
      cadenceS,
      lagP95Ms: new Map(),
      backlog: { files: 0, bytes: 0, age_s: null },
      badLines: 0,
      now: AFTER,
    };
    const status = async () =>
      (await h.t.admin.query<{ status: string }>(`SELECT status FROM source_health WHERE source_id = 'CH-3'`)).rows[0]
        ?.status;
    // The CH-3 seed was fetched days before AFTER: not down as a seed-only source.
    await computeHealth(h.load.db, { ...inputs, seedOnly });
    expect(await status()).toBe('ok');
    // Without the set, a source with neither a seed spec nor a cron spec it knows of is judged on its fetch age.
    await computeHealth(h.load.db, inputs);
    expect(await status()).toBe('down');
  });

  it('a latest row filled by another source is neither fresh nor provider-stale for its target (review CR-3)', async () => {
    const x = await harness();
    const NOW = new Date('2026-10-01T12:00:00Z');
    const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
    try {
      const own = (series: string, ts: string) => ({ series, ts, value: 1, qc: QC.RAW });
      const adapters: Record<string, LoadAdapter> = {
        'FR-1': {
          version: 1,
          specs: {
            'fr-1-obs': {
              maxBytes: 1024,
              needsVariant: false,
              run: () => ({ obs: [own('A061005051/H', ago(10))], gaugeZeros: [], dropped: {}, unknown: 0 }),
            },
          },
        },
        'FR-3': {
          version: 1,
          specs: {
            'fr-3-obs': {
              maxBytes: 1024,
              needsVariant: false,
              fill: 'FR-1',
              // Chooz H: a fill row that is recent; Uckange Q: one that is stale, stated by a payload of 5 min ago.
              run: () => ({
                obs: [],
                gaugeZeros: [],
                dropped: {},
                unknown: 0,
                fill: [own('B720000001/H', ago(10)), own('A850061001/Q', ago(300))],
              }),
            },
          },
        },
      };
      for (const [source, spec] of [
        ['FR-1', 'fr-1-obs'],
        ['FR-3', 'fr-3-obs'],
      ] as const) {
        await writePayload(x.archive, {
          source,
          spec,
          variant: 'default',
          at: new Date(NOW.getTime() - 5 * 60_000),
          body: Buffer.from(`{"${source}":1}`),
          url: 'https://example.org/',
        });
      }
      expect(await x.loader({ adapters, now: NOW }).tick()).toEqual({ lines: 2, loaded: 2 });
      const { rows: latest } = await x.t.admin.query<{ provider_key: string; qc: number }>(
        `SELECT s.provider_key, l.qc FROM obs_latest l JOIN series s ON s.id = l.series_id
         WHERE s.source_id = 'FR-1' ORDER BY 1`,
      );
      expect(latest).toEqual([
        { provider_key: 'A061005051/H', qc: QC.RAW },
        { provider_key: 'A850061001/Q', qc: QC.RAW | QC.BACKFILLED },
        { provider_key: 'B720000001/H', qc: QC.RAW | QC.BACKFILLED },
      ]);
      await computeHealth(x.load.db, {
        cadenceS: new Map([
          ['FR-1', 900],
          ['FR-3', 21_600],
        ]),
        lagP95Ms: new Map(),
        backlog: { files: 0, bytes: 0, age_s: null },
        badLines: 0,
        now: NOW,
      });
      const { rows } = await x.t.admin.query<{ tier1: { total: number; fresh: number; provider_stale: number } }>(
        `SELECT detail->'tier1' AS tier1 FROM source_health WHERE source_id = 'FR-1'`,
      );
      // Only FR-1's own row is fresh; the fresh fill row and the stale one stated lately count for nothing.
      expect(rows[0]?.tier1).toMatchObject({ fresh: 1, provider_stale: 0 });
      expect(rows[0]?.tier1.total).toBeGreaterThan(3);
    } finally {
      await x.close();
    }
  }, 60_000);
});

describe('the attribution of the fill sources (review SR-1)', () => {
  it('/meta lists FR-3 and CH-3 beside FR-1 and CH-1, as their own entries; never a fill source the views hide', async () => {
    expect(FILLED_BY).toEqual(
      new Map([
        ['CH-1', ['CH-3']],
        ['FR-1', ['FR-3']],
      ]),
    );
    const x = await harness();
    try {
      const api = x.dbAs('rws_api');
      const sources = async () => (await readMeta(api.db, { dataEpochMs: 0, displayStartMs: 0 }, 'dev', AFTER)).sources;
      const all = await sources();
      // P5b: DE-7 and LU-1 are public sources with public series too. P8b: CH-4 and FR-4, whose forecast runs sit on
      // CH-1 and FR-1 series, are listed beside them for their attribution; DE-2, DE-3 and LU-3 (owner) never are.
      expect(all.map((s) => s.id)).toEqual([
        'CH-1',
        'CH-3',
        'CH-4',
        'DE-1',
        'DE-7',
        'FR-1',
        'FR-3',
        'FR-4',
        'LU-1',
        'NL-1',
      ]);
      // The registry's rows verbatim, the date duty included: FR-3's own text, and CH-3's three (CH-1's wording).
      expect(all.find((s) => s.id === 'FR-3')?.attribution).toEqual([
        {
          lang: 'fr',
          text: 'Source : © VIGICRUES – www.vigicrues.gouv.fr, [date de mise à jour], Licence Ouverte Etalab 2.0',
          url: null,
          required: true,
          needsDate: true,
        },
      ]);
      expect(all.find((s) => s.id === 'CH-3')?.attribution).toEqual(all.find((s) => s.id === 'CH-1')?.attribution);
      expect(all.find((s) => s.id === 'CH-3')?.attribution).toHaveLength(3);
      // A fill source that the public attribution view hides (no display channel, or not public) is never listed.
      await x.t.admin.query(`UPDATE source SET lic_display = false WHERE id = 'FR-3'`);
      await x.t.admin.query(`UPDATE source SET audience = 'off' WHERE id = 'CH-3'`);
      expect((await sources()).map((s) => s.id)).toEqual([
        'CH-1',
        'CH-4',
        'DE-1',
        'DE-7',
        'FR-1',
        'FR-4',
        'LU-1',
        'NL-1',
      ]);
      // A fill source is listed only beside a source that is listed itself.
      await x.t.admin.query(`UPDATE source SET lic_display = true WHERE id = 'FR-3'`);
      expect((await sources()).map((s) => s.id)).toEqual([
        'CH-1',
        'CH-4',
        'DE-1',
        'DE-7',
        'FR-1',
        'FR-3',
        'FR-4',
        'LU-1',
        'NL-1',
      ]);
      await x.t.admin.query(`UPDATE series SET active = false WHERE source_id = 'FR-1'`);
      expect((await sources()).map((s) => s.id)).toEqual(['CH-1', 'CH-4', 'DE-1', 'DE-7', 'LU-1', 'NL-1']);
    } finally {
      await x.close();
    }
  }, 60_000);
});
