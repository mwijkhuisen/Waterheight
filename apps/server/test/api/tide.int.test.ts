import { readFileSync } from 'node:fs';
import { CANARIES, SeriesAnswer, SnapshotAnswer } from '@rws/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recorded, writePayload } from '../../../../scripts/fixture-archive.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import { VIEWS } from '../../src/db/audience.ts';
import { type Db, type DbConfig, dbConfig, openDb } from '../../src/db/pool.ts';
import { OWNER_CANARY, seedAudienceFixture, WITHHELD_CANARY, WITHHELD_KEYS } from '../db/seed.ts';
import { createTestDb, type LoginRole, type TestDb } from '../db/testdb.ts';
import { type Harness, harness } from '../load/harness.ts';
import { ask, grep, iso as isoZ, type Req } from './sweep.ts';

// P18a criterion 2: the hand-built Den Helder storm (nl-1-storm-denhelder-*, synthetic, +250 cm held for six hours) through
// parse, normalise and the loader into the real database, read back through the public API: /series/{id} (raw: the
// astronomical curve, the surge at the measured instants, the high and low waters) and /snapshot (the item's tide).
// Then the canaries: tide rows on the owner canary, the withheld series and the display-only series reach no public
// body that may not show them.

/** An instant as the API writes it in an answer: UTC, milliseconds, `Z`. */
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;
const DEN_HELDER = 'denhelder.marsdiep/WATHTE/NAP/other:F007';
/** The three payloads are fetched at the fixtures' recorded_at, 2026-12-12T03:55:00Z; the loader runs just after. */
const STORM = {
  obs: recorded('nl-1-storm-denhelder-obs.synthetic', 'NL-1'),
  astro: recorded('nl-1-storm-denhelder-astro.synthetic', 'NL-1'),
  hwlw: recorded('nl-1-storm-denhelder-hwlw-astro.synthetic', 'NL-1'),
};
const LOADER_NOW = new Date(STORM.obs.at.getTime() + 5 * MIN);
/** The API's clock: later than every `to` asked below. */
const API_NOW = Date.parse('2026-12-12T12:30:00Z');
/** Six hours at exactly +250 cm: 36 values at 10 minutes, 20:00Z to 01:50Z (21:00 to 02:50 at the fixed +01:00). */
const PLATEAU_FIRST = Date.parse('2026-12-11T20:00:00Z');
const PLATEAU_LAST = Date.parse('2026-12-12T01:50:00Z');
const LAST_MEASURED = Date.parse('2026-12-12T03:50:00Z');
/** Local midnight (00:00 at +01:00) is 23:00Z; the fixture has a high water exactly there. */
const MIDNIGHT = Date.parse('2026-12-11T23:00:00Z');
const FROM = Date.parse('2026-12-11T04:00:00Z');
const TO = Date.parse('2026-12-12T12:00:00Z');

type Meting = { Tijdstip: string; Meetwaarde: { Waarde_Numeriek: number } };
/** The fixture's own list: [instant (UTC ms), cm] in file order, and the Tijdstip strings as RWS wrote them. */
function listOf(f: { body: Buffer }): { ts: number; value: number; stamp: string }[] {
  const doc = JSON.parse(f.body.toString('utf8')) as { WaarnemingenLijst: { MetingenLijst: Meting[] }[] };
  return (doc.WaarnemingenLijst[0]?.MetingenLijst ?? []).map((m) => ({
    ts: Date.parse(m.Tijdstip),
    value: m.Meetwaarde.Waarde_Numeriek,
    stamp: m.Tijdstip,
  }));
}
const measured = listOf(STORM.obs);
const astro = listOf(STORM.astro);
const hwlw = listOf(STORM.hwlw);
const astroAt = new Map(astro.map((p) => [p.ts, p.value]));

let h: Harness;
let denHelder: number;
let apiDb: Db;
let app: ReturnType<typeof createApp>;
const q = async (text: string, args: unknown[] = []) => (await h.t.admin.query(text, args)).rows;
const get = (path: string): Req => ({ path, label: path });
const json = async (path: string) => {
  const a = await ask(app, get(path), 'identity');
  expect(a.status, path).toBe(200);
  return JSON.parse(a.text);
};
const seriesPath = (from: number, to: number, id = denHelder) =>
  `/api/v1/series/${id}?from=${isoZ(from)}&to=${isoZ(to)}`;
const snapshotPath = (t: number) => `/api/v1/snapshot?t=${isoZ(t)}`;
const item = (snap: SnapshotAnswer, id = denHelder) => snap.values.find((v) => v.series === id);

beforeAll(async () => {
  h = await harness();
  denHelder = await h.seriesId(DEN_HELDER);
  // astro first, then the extremes (heights only: the labels come from strict alternation), then the observations.
  for (const [name, f, spec, variant] of [
    ['astro', STORM.astro, 'nl-1-astro', 'denhelder.marsdiep/NAP'],
    ['hwlw', STORM.hwlw, 'nl-1-hwlw-astro', 'denhelder.marsdiep/NAP/NVT'],
    ['obs', STORM.obs, 'nl-1-obs-sea', 'denhelder.marsdiep/H/NAP'],
  ] as const) {
    await writePayload(h.archive, {
      source: 'NL-1',
      spec,
      variant,
      at: f.at,
      body: f.body,
      url: f.url,
      method: 'POST',
      retention: name === 'obs' ? 'obs' : 'forever',
    });
  }
  expect(await h.loader({ now: LOADER_NOW }).tick()).toEqual({ lines: 3, loaded: 3 });
  apiDb = h.dbAs('rws_api', 4);
  const window = new DisplayWindow(apiDb.db);
  expect(await window.refresh()).toBe(true);
  app = createApp({ db: apiDb.db, window, now: () => new Date(API_NOW) });
}, 180_000);
afterAll(() => h?.close());

describe('the storm fixture and the loader', { timeout: 120_000 }, () => {
  it('is hand-built as it says: 144 measured and 264 astro values every 10 minutes, 36 at +250, 8 alternating extremes', () => {
    expect([measured.length, astro.length, hwlw.length]).toEqual([144, 264, 8]);
    // The fixed +01:00 with milliseconds in the file, as RWS writes it.
    for (const p of [...measured, ...astro, ...hwlw]) expect(p.stamp).toMatch(/\.000\+01:00$/);
    const surge = measured.map((p) => [p.ts, p.value - (astroAt.get(p.ts) as number)] as const);
    const plateau = surge.filter(([ts]) => ts >= PLATEAU_FIRST && ts <= PLATEAU_LAST);
    expect(plateau).toHaveLength(36);
    expect(new Set(plateau.map(([, s]) => s))).toEqual(new Set([250]));
    // Nothing else reaches 250: the ramps stay below, the rest is calm.
    expect(surge.filter(([, s]) => s >= 250)).toHaveLength(36);
    expect(plateau[0]?.[0]).toBe(Date.parse('2026-12-11T20:00:00.000Z'));
    expect(measured.find((p) => p.ts === PLATEAU_FIRST)?.stamp).toBe('2026-12-11T21:00:00.000+01:00');
    expect(measured.at(-1)?.ts).toBe(LAST_MEASURED);
    // Strict alternation, one extreme exactly on local midnight, a pair around it.
    hwlw.forEach((p, i) => {
      if (i > 0) expect(Math.sign(p.value - (hwlw[i - 1] as { value: number }).value)).not.toBe(0);
    });
    expect(hwlw.map((p) => p.value > 0)).toEqual([false, true, false, true, false, true, false, true]);
    expect(hwlw.some((p) => p.ts === MIDNIGHT)).toBe(true);
  });

  it('loads in full: the observations into obs, the astro curve and the extremes into tide, labelled by alternation', async () => {
    expect(await q('SELECT count(*)::int AS n FROM obs WHERE series_id = $1', [denHelder])).toEqual([{ n: 144 }]);
    expect(await q('SELECT kind, count(*)::int AS n FROM tide GROUP BY kind ORDER BY kind')).toEqual([
      { kind: 'astro', n: 264 },
      { kind: 'extreme_astro', n: 8 },
    ]);
    const rows = await q(
      `SELECT ts, value, hilo FROM tide WHERE series_id = $1 AND kind = 'extreme_astro' ORDER BY ts`,
      [denHelder],
    );
    expect(rows.map((r) => [(r.ts as Date).getTime(), r.value, r.hilo])).toEqual(
      hwlw.map((p) => [p.ts, p.value, p.value > 0 ? 'high' : 'low']),
    );
    expect(h.alerts.filter((a) => ['quarantined', 'load_stalled', 'hwlw_unlabelled'].includes(a.code))).toEqual([]);
  });
});

describe('/series/{id}: the storm over [from, to)', { timeout: 120_000 }, () => {
  it('raw: the surge is exactly +250 at each of the 36 plateau points, and every surge point is a measured point', async () => {
    const body = await json(seriesPath(FROM, TO));
    const answer = SeriesAnswer.parse(body);
    if (answer.res !== 'raw') throw new Error('not raw');
    expect(answer.points).toHaveLength(144);
    const tide = answer.tide;
    if (tide === undefined) throw new Error('no tide');
    expect(tide.derived).toBe('surge');
    const surge = new Map(tide.surge.map((p) => [Date.parse(p.ts), p.value]));
    const plateau = Array.from({ length: 36 }, (_, i) => PLATEAU_FIRST + i * 10 * MIN);
    expect(plateau.at(-1)).toBe(PLATEAU_LAST);
    for (const ts of plateau) expect(surge.get(ts), iso(ts)).toBe(250);
    const points = new Set(answer.points.map((p) => Date.parse(p.ts)));
    for (const ts of surge.keys()) expect(points.has(ts), iso(ts)).toBe(true);
    // The surge is value − astro at the very instant, everywhere (an astro row exists for every measured point).
    expect(tide.surge).toHaveLength(144);
    for (const p of answer.points)
      expect(surge.get(Date.parse(p.ts)), p.ts).toBe(p.value - (astroAt.get(Date.parse(p.ts)) as number));
    // The last measurement is mid ramp-down: +19.
    expect(surge.get(LAST_MEASURED)).toBe(19);
  });

  it('raw: tide.astro is the fixture curve over [from, to) and the output is UTC Z, one hour before the input', async () => {
    const answer = SeriesAnswer.parse(await json(seriesPath(FROM, TO)));
    if (answer.res !== 'raw' || answer.tide === undefined) throw new Error('no raw tide');
    const want = astro.filter((p) => p.ts >= FROM && p.ts < TO);
    expect(want).toHaveLength(192);
    expect(answer.tide.astro).toEqual(want.map((p) => ({ ts: iso(p.ts), value: p.value })));
    // Input 21:00 at +01:00 is 20:00Z: one hour earlier, written with Z.
    const first = answer.tide.surge.find((p) => p.ts === '2026-12-11T20:00:00.000Z');
    expect(first?.value).toBe(250);
    expect(measured.find((p) => p.stamp === '2026-12-11T21:00:00.000+01:00')?.ts).toBe(Date.parse(first?.ts ?? ''));
    for (const p of [...answer.points, ...answer.tide.astro, ...answer.tide.surge, ...answer.tide.extremes])
      expect(p.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('raw: tide.extremes are the hwlw-astro list, each once, kinds astro, across local midnight', async () => {
    const want = hwlw
      .filter((p) => p.ts >= FROM && p.ts < TO)
      .map((p) => ({ ts: iso(p.ts), value: p.value, hilo: p.value > 0 ? 'high' : 'low', kind: 'astro' }));
    expect(want).toHaveLength(6);
    const whole = SeriesAnswer.parse(await json(seriesPath(FROM, TO)));
    if (whole.res !== 'raw') throw new Error('not raw');
    expect(whole.tide?.extremes).toEqual(want);
    // Two spans that meet at the local midnight: the high water exactly on it is in the later one only.
    const before = SeriesAnswer.parse(await json(seriesPath(FROM, MIDNIGHT)));
    const after = SeriesAnswer.parse(await json(seriesPath(MIDNIGHT, TO)));
    if (before.res !== 'raw' || after.res !== 'raw') throw new Error('not raw');
    const a = before.tide?.extremes ?? [];
    const b = after.tide?.extremes ?? [];
    expect(a.map((e) => e.ts)).not.toContain(iso(MIDNIGHT));
    expect(b[0]?.ts).toBe(iso(MIDNIGHT));
    expect([...a, ...b]).toEqual(want);
    expect(new Set([...a, ...b].map((e) => e.ts)).size).toBe(want.length);
  });

  it('raw: derived is "surge" and the answer attributes NL-1 only', async () => {
    const body = await json(seriesPath(FROM, TO));
    expect(body.tide.derived).toBe('surge');
    expect(body.attribution.map((a: { source: string }) => a.source)).toEqual(['NL-1']);
  });

  it('1h and 1d carry no tide', async () => {
    for (const res of ['1h', '1d']) {
      const body = await json(`${seriesPath(FROM, TO)}&res=${res}`);
      expect(body.res).toBe(res);
      expect(body).not.toHaveProperty('tide');
    }
  });
});

describe('/snapshot: the item of the Den Helder series', { timeout: 120_000 }, () => {
  it('inside the plateau: surge 250, astro at the item ts, previous and next astro high and low water', async () => {
    const t = Date.parse('2026-12-12T00:00:00Z');
    const snap = SnapshotAnswer.parse(await json(snapshotPath(t)));
    const v = item(snap);
    expect(v?.ts).toBe(iso(t));
    expect(v?.value).toBe((astroAt.get(t) as number) + 250);
    expect(v?.tide).toEqual({
      astro: astroAt.get(t),
      surge: 250,
      derived: 'surge',
      // Previous (<= t) and next (> t) high and low water of the astronomical tide, by time.
      extremes: [
        { ts: '2026-12-11T16:48:00.000Z', value: -76, hilo: 'low', kind: 'astro' },
        { ts: iso(MIDNIGHT), value: 83, hilo: 'high', kind: 'astro' },
        { ts: '2026-12-12T05:13:00.000Z', value: -75, hilo: 'low', kind: 'astro' },
        { ts: '2026-12-12T11:25:00.000Z', value: 87, hilo: 'high', kind: 'astro' },
      ],
    });
    expect(snap.attribution.map((a) => a.source)).toEqual(['NL-1']);
  });

  it('carried forward ten minutes past the last measurement: the surge uses the astro at the measured ts, not at t', async () => {
    const t = LAST_MEASURED + 10 * MIN;
    const a0 = astroAt.get(LAST_MEASURED) as number;
    const a1 = astroAt.get(t) as number;
    expect(a1).not.toBe(a0);
    const v = item(SnapshotAnswer.parse(await json(snapshotPath(t))));
    expect(v?.ts).toBe(iso(LAST_MEASURED));
    expect(v?.ageSeconds).toBe(600);
    expect(v?.tide?.astro).toBe(a0);
    expect(v?.tide?.surge).toBe(19);
    expect(v?.tide?.surge).not.toBe(Math.round((v?.value ?? 0) - a1));
  });

  it('past the staleness limit there is no value and no tide', async () => {
    // PT1H: the last measurement (03:50) is out of (t - 1 h, t] from 04:50 on; the astro curve goes on to 23:50.
    for (const t of [LAST_MEASURED + HOUR, LAST_MEASURED + 2 * HOUR]) {
      const snap = SnapshotAnswer.parse(await json(snapshotPath(t)));
      expect(item(snap), iso(t)).toBeUndefined();
      expect(astroAt.has(t)).toBe(true);
    }
    // Still inside it at 04:40.
    expect(item(SnapshotAnswer.parse(await json(snapshotPath(LAST_MEASURED + 50 * MIN))))?.tide?.surge).toBe(19);
  });

  it('a measured value whose ts has no astro row gives astro null and surge null', async () => {
    const odd = Date.parse('2026-12-12T04:03:00Z');
    await q('INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, 60, 1, 1)', [
      denHelder,
      new Date(odd),
    ]);
    try {
      expect(astroAt.has(odd)).toBe(false);
      const v = item(SnapshotAnswer.parse(await json(snapshotPath(LAST_MEASURED + 20 * MIN))));
      expect(v?.ts).toBe(iso(odd));
      expect(v?.tide).toMatchObject({ astro: null, surge: null, derived: 'surge' });
      expect(v?.tide?.extremes.length).toBeGreaterThan(0);
    } finally {
      await q('DELETE FROM obs WHERE series_id = $1 AND ts = $2', [denHelder, new Date(odd)]);
    }
  });
});

describe('D-5: units and datum', () => {
  it('every series with tide rows has to_canonical 1 and native unit cm', async () => {
    const rows = await q(
      `SELECT s.id, s.to_canonical, s.native_unit, s.datum FROM series s
       WHERE EXISTS (SELECT 1 FROM tide t WHERE t.series_id = s.id)`,
    );
    expect(rows).toEqual([{ id: denHelder, to_canonical: 1, native_unit: 'cm', datum: 'NAP' }]);
  });

  it('and so does every series the registry can ever give tide rows (every row of nl-1-tide.csv)', async () => {
    const csv = readFileSync(new URL('../../../../registry/seed/nl-1-tide.csv', import.meta.url), 'utf8');
    const wanted = new Set(
      csv
        .split('\n')
        .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('code,'))
        .map((l) => l.split(','))
        .map(([code, , datum]) => `${code}/WATHTE/${datum}/`),
    );
    expect(wanted.size).toBeGreaterThan(50);
    const rows = await q(
      `SELECT s.provider_key, s.to_canonical, s.native_unit FROM series s
       WHERE s.source_id = 'NL-1' AND s.role = 'primary'
         AND EXISTS (SELECT 1 FROM unnest($1::text[]) w WHERE left(s.provider_key, length(w)) = w)`,
      [[...wanted]],
    );
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.filter((r) => r.to_canonical !== 1 || r.native_unit !== 'cm')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The canaries. The audience fixture of the database tests (seed.ts): every station tidal, tide rows (written here, as
// the loader would store them) on the public series, the owner canary, the four withheld series and the display-only
// series. The display channel shows a display-only series (its value is in /snapshot, as canaries.int.test.ts holds for
// the values themselves); it is not served by /series, whose api channel it is not in.

const CHANNEL = { value: 654321.987, text: '654321.987' } as const;
const CHANNEL_NEEDLES = [CHANNEL.text, '654321.9', /(?<![0-9.])654322(?![0-9])/] as const;
const OWNER_NEEDLES = [CANARIES.owner.text, CANARIES.owner.real, '777777.7'] as const;
const WITHHELD_NEEDLES = [CANARIES.withheld.text, CANARIES.withheld.real, '123456.7', 'nl.canary.withheld'] as const;

describe('tide canaries', { timeout: 180_000 }, () => {
  let t: TestDb;
  let ids: Record<string, number>;
  let h0: Date;
  let tNow: number;
  const dbs: Db[] = [];
  const apps = {} as Record<'public' | 'owner', ReturnType<typeof createApp>>;
  const open = (role: LoginRole, max: number): Db => {
    const db = openDb(dbConfig({ DATABASE_URL: t.urlFor(role) }, role) as DbConfig, { max });
    dbs.push(db);
    return db;
  };
  const tide = (key: string, kind: string, ts: Date, value: number, hilo: string | null = null) =>
    t.admin.query('INSERT INTO tide (series_id, kind, ts, value, hilo, batch_id) VALUES ($1, $2, $3, $4, $5, 1)', [
      ids[key],
      kind,
      ts,
      value,
      hilo,
    ]);
  const ask1 = async (family: 'public' | 'owner', path: string) => ask(apps[family], get(path), 'identity');

  beforeAll(async () => {
    t = await createTestDb();
    ids = await seedAudienceFixture(t.admin);
    await t.admin.query(`UPDATE station SET flags = '{"tidal": true}'`);
    await t.admin.query("UPDATE series SET staleness_limit = '2 hours'");
    h0 = ((await t.admin.query('SELECT date_trunc($$hour$$, now()) AS h')).rows[0] as { h: Date }).h;
    tNow = h0.getTime() + 10 * MIN;
    await t.admin.query(`UPDATE app_meta SET value = to_jsonb($1::text) WHERE key = 'display_start'`, [
      isoZ(h0.getTime() - 30 * 24 * HOUR),
    ]);
    const value = (key: string) =>
      (WITHHELD_KEYS as readonly string[]).includes(key)
        ? WITHHELD_CANARY
        : key === 'ownerCanary'
          ? OWNER_CANARY
          : key === 'displayOnly'
            ? CHANNEL.value
            : 90;
    // The seed's observations are at the top of the hour (100 on the public series). An astro row there and at t (surge
    // 100 - 90 on the public series) and a high water an hour before, for every series that matters.
    for (const key of ['public', 'ownerCanary', 'displayOnly', 'noApi', ...WITHHELD_KEYS]) {
      await tide(key, 'astro', h0, value(key));
      await tide(key, 'astro', new Date(tNow), value(key));
      await tide(key, 'extreme_astro', new Date(h0.getTime() - HOUR), value(key), 'high');
    }
    for (const [family, role, max] of [
      ['public', 'rws_api', 4],
      ['owner', 'rws_owner_api', 2],
    ] as const) {
      const db = open(role, max);
      const window = new DisplayWindow(db.db, undefined, family);
      expect(await window.refresh()).toBe(true);
      apps[family] = createApp({ family, db: db.db, window, now: () => new Date(tNow) });
    }
  }, 120_000);
  afterAll(async () => {
    await Promise.allSettled(dbs.map((d) => d.close()));
    await t?.drop();
  });

  const snap = async (family: 'public' | 'owner') => {
    const a = await ask1(family, snapshotPath(tNow));
    expect(a.status, family).toBe(200);
    return { text: a.text, doc: JSON.parse(a.text) as { values: { series: number; value: number; tide?: unknown }[] } };
  };

  it('the public snapshot shows the tide of a public series, and nothing of the owner canary or the withheld series', async () => {
    const { text, doc } = await snap('public');
    expect(doc.values.find((v) => v.series === ids.public)?.tide).toMatchObject({
      astro: 90,
      surge: 10,
      derived: 'surge',
      extremes: [{ value: 90, hilo: 'high', kind: 'astro' }],
    });
    expect(grep([{ label: 'public snapshot', text }], [...OWNER_NEEDLES, ...WITHHELD_NEEDLES])).toEqual([]);
    for (const key of ['ownerCanary', ...WITHHELD_KEYS])
      expect(doc.values.map((v) => v.series)).not.toContain(ids[key]);
  });

  it('the public /series shows the tide of a public series and answers 404 for every canary series, body clean', async () => {
    const win = `from=${isoZ(h0.getTime() - 2 * HOUR)}&to=${isoZ(tNow + 10 * MIN)}`;
    const ok = await ask1('public', `/api/v1/series/${ids.public}?${win}`);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text).tide.astro.map((p: { value: number }) => p.value)).toEqual([90, 90]);
    for (const key of ['ownerCanary', 'displayOnly', ...WITHHELD_KEYS]) {
      const a = await ask1('public', `/api/v1/series/${ids[key]}?${win}`);
      expect([key, a.status, a.text]).toEqual([key, 404, '{"error":"not_found","attribution":[]}']);
    }
    // The display-only series is in the display channel (snapshot) but not in the api channel (/series).
    expect(
      grep([{ label: 'public series', text: ok.text }], [...OWNER_NEEDLES, ...WITHHELD_NEEDLES, ...CHANNEL_NEEDLES]),
    ).toEqual([]);
  });

  it('the api tide view of the public family holds the public series only; the base table holds every canary row', async () => {
    const pub = await t.connectAs('rws_api');
    const rows = (await pub.query(`SELECT DISTINCT series_id FROM ${VIEWS.public.api.tide}`)).rows as {
      series_id: number;
    }[];
    expect(rows.map((r) => r.series_id)).toEqual([ids.public]);
    await pub.end();
    const n = await t.admin.query('SELECT count(DISTINCT series_id)::int AS n FROM tide WHERE series_id = ANY($1)', [
      [ids.ownerCanary, ids.displayOnly, ...WITHHELD_KEYS.map((k) => ids[k])],
    ]);
    expect(n.rows).toEqual([{ n: 2 + WITHHELD_KEYS.length }]);
  });

  it('the display-only series: its tide is in the display channel (/snapshot) and in no api answer', async () => {
    const { doc } = await snap('public');
    expect(doc.values.find((v) => v.series === ids.displayOnly)?.tide).toMatchObject({ astro: 654322 });
  });

  it('the owner snapshot shows the owner canary tide and still not the withheld series', async () => {
    const { text, doc } = await snap('owner');
    const own = doc.values.find((v) => v.series === ids.ownerCanary);
    expect(own?.tide).toMatchObject({ astro: Number(CANARIES.owner.real), derived: 'surge' });
    expect(grep([{ label: 'owner snapshot', text }], OWNER_NEEDLES).length).toBeGreaterThan(0);
    expect(grep([{ label: 'owner snapshot', text }], WITHHELD_NEEDLES)).toEqual([]);
    expect(doc.values.map((v) => v.series)).not.toContain(ids.withheld);
  });

  it('the owner /series shows the owner canary tide; the withheld series is a 404 there too', async () => {
    const win = `from=${isoZ(h0.getTime() - 2 * HOUR)}&to=${isoZ(tNow + 10 * MIN)}`;
    const a = await ask1('owner', `/api/v1/series/${ids.ownerCanary}?${win}`);
    expect(a.status).toBe(200);
    expect(JSON.parse(a.text).tide.astro.map((p: { value: number }) => p.value)).toEqual([
      Number(CANARIES.owner.real),
      Number(CANARIES.owner.real),
    ]);
    for (const key of WITHHELD_KEYS) {
      const w = await ask1('owner', `/api/v1/series/${ids[key]}?${win}`);
      expect([key, w.status]).toEqual([key, 404]);
    }
  });
});
