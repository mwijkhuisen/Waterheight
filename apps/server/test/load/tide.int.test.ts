import { CANARIES } from '@rws/contracts';
import { emptyNormalised, type TideRowIn } from '@rws/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recorded, writePayload } from '../../../../scripts/fixture-archive.ts';
import { VIEWS } from '../../src/db/audience.ts';
import type { LoadAdapter } from '../../src/load/adapters.ts';
import { syncOwnerCanary } from '../../src/load/canary.ts';
import { replay } from '../../src/load/replay.ts';
import { lock } from '../../src/load/store.ts';
import { sqlState } from '../db/testdb.ts';
import { type Harness, harness } from './harness.ts';

// P16b criterion 3, through the real loader (the NL-1 adapter, the pipeline, `tide` as rws_load): a replay of the
// recorded astronomical tide (Vlissingen NAP, the trimmed 1,800 values) stores future rows in `tide` and none in
// `obs`; only the view pair reads the table; a second pass, and a newer fetch of the same curve, write nothing (not
// even a batch id); newest fetch wins for a changed value. Then the pipeline's own rules with a stand-in adapter: a
// tide row attaches to a primary series only, an `off` one takes none, an unknown key is skipped, and
// `hwlw_unlabelled` is retained and alerted.

const ASTRO = recorded('nl-1-astro-vlissingen-nap', 'NL-1');
const VLISSINGEN = 'vlissingen/WATHTE/NAP/other:F007';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The loader's clock: after every fetch below (it dates the dirty rows only; tide makes none). */
const NOW = new Date(ASTRO.at.getTime() + 40 * DAY);

type Row = Record<string, unknown>;
let h: Harness;
const q = async (text: string, args: unknown[] = []): Promise<Row[]> => (await h.t.admin.query(text, args)).rows;
const deps = () => ({
  db: h.load.db,
  reader: h.reader,
  alert: (code: string, fields: Record<string, string | number> = {}) => h.alerts.push({ code, fields }),
  now: () => NOW,
});
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const REPLAY = { source: 'NL-1', spec: 'nl-1-astro', from: day(ASTRO.at.getTime()), to: day(NOW.getTime()) } as const;

const put = (body: Buffer, at: Date, spec = 'nl-1-astro') =>
  writePayload(h.archive, {
    source: 'NL-1',
    spec,
    variant: 'vlissingen/NAP',
    at,
    body,
    url: ASTRO.url,
    method: 'POST',
    retention: 'forever',
  });

type Meting = { Tijdstip: string; Meetwaarde: { Waarde_Numeriek: number } };
const metingen = (doc: unknown) =>
  (doc as { WaarnemingenLijst: { MetingenLijst: Meting[] }[] }).WaarnemingenLijst[0]?.MetingenLijst as Meting[];
/** The instant (UTC ms) of the recorded body's value at `index` (its Tijdstip carries +01:00). */
const instantOf = (index: number) =>
  Date.parse((metingen(JSON.parse(ASTRO.body.toString('utf8')))[index] as Meting).Tijdstip);

/** The recorded body with the value at `index` moved by `delta` cm. */
function changed(index: number, delta: number): Buffer {
  const doc = JSON.parse(ASTRO.body.toString('utf8'));
  const m = metingen(doc)[index] as Meting;
  const v = m.Meetwaarde.Waarde_Numeriek + delta;
  m.Meetwaarde = { Waarde_Alfanumeriek: String(v), Waarde_Numeriek: v } as Meting['Meetwaarde'];
  return Buffer.from(JSON.stringify(doc));
}

/** Every tide row with the batch and the transaction that last wrote it: a needless write shows as a new xmin. */
const tideRows = () =>
  q(
    `SELECT series_id, kind, ts, value, hilo, batch_id::text AS batch, xmin::text AS xmin
     FROM tide ORDER BY series_id, kind, ts`,
  );
const batches = () =>
  q(
    `SELECT id::text AS id, spec_id, parse_status, n_rows, n_new, n_changed, n_skipped, error
     FROM ingest_batch ORDER BY id`,
  );

describe('the astronomical tide through the loader (criterion 3)', { timeout: 300_000 }, () => {
  let stored: Row[];
  beforeAll(async () => {
    h = await harness();
  }, 120_000);
  afterAll(() => h.close());

  it('a replay of the astro payload stores its future rows in tide and none in obs', async () => {
    await put(ASTRO.body, ASTRO.at);
    const first = await replay(deps(), { ...REPLAY, dryRun: false });
    stored = await tideRows();
    expect(stored.length).toBeGreaterThan(0);
    expect(first).toEqual({ lines: 1, loaded: 1, quarantined: 0, skipped: 0, n_new: stored.length, n_changed: 0 });
    const vlissingen = await h.seriesId(VLISSINGEN);
    for (const r of stored) {
      expect(r).toMatchObject({ series_id: vlissingen, kind: 'astro', hilo: null });
      // Ahead of the fetch: what an observation path would drop as `future`, or store as a measurement.
      expect((r.ts as Date).getTime()).toBeGreaterThan(ASTRO.at.getTime());
    }
    const from = stored[0]?.ts as Date;
    const to = stored.at(-1)?.ts as Date;
    expect(
      await q('SELECT count(*)::int AS n FROM obs WHERE series_id = $1 AND ts BETWEEN $2 AND $3', [
        vlissingen,
        from,
        to,
      ]),
    ).toEqual([{ n: 0 }]);
    expect(await h.count('obs')).toBe(0);
    expect(await h.count('obs_latest')).toBe(0);
    expect(await batches()).toEqual([
      {
        id: expect.any(String),
        spec_id: 'nl-1-astro',
        parse_status: 'ok',
        n_rows: stored.length,
        n_new: stored.length,
        n_changed: 0,
        n_skipped: 0,
        error: null,
      },
    ]);
    expect(h.alerts.filter((a) => a.code === 'quarantined' || a.code === 'load_stalled')).toEqual([]);
    // Tide is in no published file yet: no dirty row, no day bump.
    expect(await h.count('publish_dirty')).toBe(0);
  });

  it('a second pass writes nothing: no row is rewritten, not even its batch', async () => {
    const before = await batches();
    expect(await replay(deps(), { ...REPLAY, dryRun: false })).toEqual({
      lines: 1,
      loaded: 1,
      quarantined: 0,
      skipped: 0,
      n_new: 0,
      n_changed: 0,
    });
    expect(await tideRows()).toEqual(stored);
    expect(await batches()).toEqual(before);
    // The tail then reads the line the replay loaded: the same batch, nothing written.
    expect(await h.loader({ now: NOW }).tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await tideRows()).toEqual(stored);
  });

  it('newest fetch wins: the same curve fetched later writes nothing, a changed value one row, a late line none', async () => {
    const tick = () => h.loader({ now: NOW }).tick();
    // Re-fetches within the day (the adapter keeps a value up to a day older than its fetch). The same curve again: a
    // batch that holds nothing (no tuple written).
    await put(ASTRO.body, new Date(ASTRO.at.getTime() + HOUR));
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await tideRows()).toEqual(stored);
    // A newer fetch that moves one value: that row only, held by the newer batch.
    await put(changed(5, 7), new Date(ASTRO.at.getTime() + 3 * HOUR));
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    const after = await tideRows();
    const all = await batches();
    const newest = all.at(-1) as Row;
    expect(newest).toMatchObject({ n_rows: stored.length, n_new: 0, n_changed: 1, n_skipped: 0 });
    const moved = after.filter((r, i) => r.xmin !== stored[i]?.xmin);
    const was = stored.find((r) => (r.ts as Date).getTime() === instantOf(5)) as Row;
    expect(moved).toEqual([{ ...was, value: (was.value as number) + 7, batch: newest.id, xmin: expect.any(String) }]);
    // A late line (fetched before the holder of that row, after the first fetch) with yet another value: nothing.
    await put(changed(5, 3), new Date(ASTRO.at.getTime() + 2 * HOUR));
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect((await batches()).at(-1)).toMatchObject({ n_new: 0, n_changed: 0 });
    expect(await tideRows()).toEqual(after);
    // And a replay of all four writes nothing either.
    expect(await replay(deps(), { ...REPLAY, dryRun: false })).toMatchObject({
      lines: 4,
      loaded: 4,
      n_new: 0,
      n_changed: 0,
    });
    expect(await tideRows()).toEqual(after);
  });

  it('only the view pair reads the table: rws_api and rws_publish the public view, rws_owner_api the owner view', async () => {
    const n = stored.length;
    for (const role of ['rws_api', 'rws_publish'] as const) {
      const c = await h.t.connectAs(role);
      expect((await c.query(`SELECT count(*)::int AS n FROM ${VIEWS.public.tide}`)).rows, role).toEqual([{ n }]);
      expect(await sqlState(c, 'SELECT 1 FROM tide LIMIT 1'), role).toBe('42501');
      expect(await sqlState(c, `SELECT 1 FROM ${VIEWS.owner.tide} LIMIT 1`), role).toBe('42501');
    }
    const owner = await h.t.connectAs('rws_owner_api');
    expect((await owner.query(`SELECT count(*)::int AS n FROM ${VIEWS.owner.tide}`)).rows).toEqual([{ n }]);
    expect(await sqlState(owner, 'SELECT 1 FROM tide LIMIT 1')).toBe('42501');
    expect(await sqlState(owner, `SELECT 1 FROM ${VIEWS.public.tide} LIMIT 1`)).toBe('42501');
    // The loader writes the table and reads no view; it cannot delete a row.
    const load = await h.t.connectAs('rws_load');
    expect(await sqlState(load, `SELECT 1 FROM ${VIEWS.public.tide} LIMIT 1`)).toBe('42501');
    expect(await sqlState(load, 'DELETE FROM tide')).toBe('42501');
  });
});

describe('the pipeline attaches tide rows to primary series only', { timeout: 300_000 }, () => {
  const TWIN = 'eijsden.grens/WATHTE/TAW/other:F007';
  const WITHHELD = 'lobith.bovenrijn.tolkamer/WATHTE/NAP/other:F007';
  const AT = new Date('2026-10-20T08:00:00Z');
  const row = (series: string, ts: string, value: number): TideRowIn => ({
    series,
    kind: 'extreme_astro',
    ts,
    value,
    hilo: 'high',
  });
  const STANDIN: Readonly<Record<string, LoadAdapter>> = {
    'NL-1': {
      version: 1,
      specs: {
        'nl-1-hwlw-astro': {
          maxBytes: 1024,
          needsVariant: false,
          run: () => ({
            ...emptyNormalised(),
            tide: [
              row(VLISSINGEN, '2026-10-21T01:00:00.000Z', 210),
              row(VLISSINGEN, '2026-10-21T13:20:00.000Z', 215),
              row(TWIN, '2026-10-21T01:00:00.000Z', 300),
              row(WITHHELD, '2026-10-21T01:00:00.000Z', 400),
              row('nowhere/WATHTE/NAP/other:F012', '2026-10-21T01:00:00.000Z', 500),
            ],
            dropped: { hwlw_unlabelled: 3 },
          }),
        },
      },
    },
  };

  beforeAll(async () => {
    h = await harness();
    // A series the registry withholds: it takes nothing and counts nothing (set before the loader reads the registry).
    await q(`UPDATE series SET audience = 'off' WHERE provider_key = $1`, [WITHHELD]);
  }, 120_000);
  afterAll(() => h.close());

  it('stores the primary rows; a twin is counted, an off series takes none, an unknown key is skipped', async () => {
    await put(Buffer.from('{}'), AT, 'nl-1-hwlw-astro');
    expect(await h.loader({ now: NOW, adapters: STANDIN }).tick()).toEqual({ lines: 1, loaded: 1 });
    const vlissingen = await h.seriesId(VLISSINGEN);
    expect((await tideRows()).map((r) => [r.series_id, r.kind, r.value, r.hilo])).toEqual([
      [vlissingen, 'extreme_astro', 210, 'high'],
      [vlissingen, 'extreme_astro', 215, 'high'],
    ]);
    // n_skipped: the unknown key once and the three unlabelled values (retained: a replay can still load them).
    expect(await batches()).toMatchObject([
      { parse_status: 'ok', n_rows: 2, n_new: 2, n_changed: 0, n_skipped: 1 + 3, error: null },
    ]);
    expect(h.alerts).toEqual([{ code: 'hwlw_unlabelled', fields: { source: 'NL-1', spec: 'nl-1-hwlw-astro', n: 3 } }]);
  });
});

// #174: RWS's own high/low labels. `nl-1-hwlw-astro` asks, per location, the GETETTPE type series and then the heights
// (two archived lines, type first as capture writes them). The loader stores the type in `tide_label` and gives every
// astronomical extreme RWS's label, the strict-alternation label as the fallback, and nothing if it has neither.
// The Goeree lichteiland MSL pair is real (both recordings of 2026-10-17). RWS published no agger (a double low water)
// in anything we recorded, so the agger and the conflict are SYNTHETIC: heights built in the test from the real
// Vlissingen type series (its instants and words) with generated values.

type Mt = {
  Meetwaarde: { Waarde_Alfanumeriek: string; Waarde_Numeriek: number };
  Tijdstip: string;
  WaarnemingMetadata: Record<string, unknown>;
};
type Lijst = { AquoMetadata: Record<string, unknown>; Locatie: unknown; MetingenLijst: Mt[] };
type Doc = { Succesvol: boolean; WaarnemingenLijst: Lijst[] };
const docOf = (name: string): Doc => JSON.parse(recorded(name, 'NL-1').body.toString('utf8'));
const bytes = (doc: Doc) => Buffer.from(JSON.stringify(doc));
const listOf = (doc: Doc): Lijst => doc.WaarnemingenLijst[0] as Lijst;

const GOEREE = 'goeree.lichteiland/WATHTE/MSL/other:F007';
/** The pair's fetch times: the type 180 s before its heights, as the capture spaces them. */
const TYPE_AT = new Date('2026-10-17T18:49:53Z');
const HEIGHTS_AT = new Date(TYPE_AT.getTime() + 180_000);
const LATER = (ms: number) => new Date(HEIGHTS_AT.getTime() + ms);
const SPEC = 'nl-1-hwlw-astro';
const HW_URL = recorded('nl-1-hwlw-astro-goeree-lichteiland-msl', 'NL-1').url;
const VL = 'vlissingen/NAP';

/** Heights for the instants and words of a real type series: highs near 200 cm, lows near -100 cm, alternating. */
function heightsOf(type: Doc, template: Doc, agger?: number): Buffer {
  const t = listOf(type);
  const tpl = listOf(template);
  const shape = tpl.MetingenLijst[0] as Mt;
  const MetingenLijst = t.MetingenLijst.map((m, i): Mt => {
    const high = m.Meetwaarde.Waarde_Alfanumeriek === 'hoogwater';
    // An agger breaks the alternation: one high is as low as the lows (it is no strict extreme any more).
    const v = high ? (i === agger ? -150 : 200 + (i % 7)) : -100 - (i % 5);
    return { ...shape, Tijdstip: m.Tijdstip, Meetwaarde: { Waarde_Alfanumeriek: String(v), Waarde_Numeriek: v } };
  });
  return bytes({ ...type, WaarnemingenLijst: [{ ...tpl, Locatie: t.Locatie, MetingenLijst }] });
}
const vlissingenType = () => docOf('nl-1-hwlw-astro-vlissingen-nap-getettpe');
const napTemplate = () => docOf('nl-1-hwlw-astro-hoekvanholland-nap-nvt');
const wordAt = (i: number) => listOf(vlissingenType()).MetingenLijst[i]?.Meetwaarde.Waarde_Alfanumeriek;
const flipped = (i: number) => (wordAt(i) === 'hoogwater' ? 'laagwater' : 'hoogwater');
/** The Vlissingen type series with the words of the given indexes replaced. */
function typeWith(words: Record<number, string>): Buffer {
  const doc = vlissingenType();
  for (const [i, w] of Object.entries(words))
    (listOf(doc).MetingenLijst[Number(i)] as Mt).Meetwaarde.Waarde_Alfanumeriek = w;
  return bytes(doc);
}

const line = (variant: string, body: Buffer, at: Date) =>
  writePayload(h.archive, {
    source: 'NL-1',
    spec: SPEC,
    variant,
    at,
    body,
    url: HW_URL,
    method: 'POST',
    retention: 'forever',
  });
const typeLine = (loc: string, body: Buffer, at = TYPE_AT) => line(`${loc}/GETETTPE`, body, at);
const heightsLine = (loc: string, body: Buffer, at = HEIGHTS_AT) => line(`${loc}/NVT`, body, at);
const labelRows = () =>
  q('SELECT series_id, ts, hilo, batch_id::text AS batch, xmin::text AS xmin FROM tide_label ORDER BY series_id, ts');
const tick = () => h.loader({ now: NOW }).tick();
const REPLAY_HW = { source: 'NL-1', spec: SPEC, from: day(TYPE_AT.getTime()), to: day(NOW.getTime()) } as const;
const alertsOf = (code: string) => h.alerts.filter((a) => a.code === code);
const IDS = { source: 'NL-1', spec: SPEC };

describe("RWS's labels of the astronomical extremes (#174)", { timeout: 300_000 }, () => {
  beforeEach(async () => {
    h = await harness();
  }, 120_000);
  afterEach(() => h.close());

  it('the real Goeree MSL pair: the type is stored in tide_label and the heights take its labels, no conflict', async () => {
    const goeree = await h.seriesId(GOEREE);
    await typeLine('goeree.lichteiland/MSL', recorded('nl-1-hwlw-astro-goeree-lichteiland-msl-getettpe', 'NL-1').body);
    await heightsLine('goeree.lichteiland/MSL', recorded('nl-1-hwlw-astro-goeree-lichteiland-msl', 'NL-1').body);
    expect(await tick()).toEqual({ lines: 2, loaded: 2 });
    const labels = await labelRows();
    const tide = await tideRows();
    expect(labels).toHaveLength(1545);
    expect(tide).toHaveLength(1546);
    expect(tide.every((r) => r.series_id === goeree && r.kind === 'extreme_astro')).toBe(true);
    // 1,544 instants are in both recordings and RWS's label is on the heights; the 2 heights-only edges alternate.
    const both = await q(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE t.hilo = l.hilo)::int AS same
       FROM tide t JOIN tide_label l ON l.series_id = t.series_id AND l.ts = t.ts`,
    );
    expect(both).toEqual([{ n: 1544, same: 1544 }]);
    expect(tide.every((r) => r.hilo === 'high' || r.hilo === 'low')).toBe(true);
    expect(await batches()).toMatchObject([
      { spec_id: SPEC, parse_status: 'ok', n_rows: 1545, n_new: 1545, n_changed: 0, n_skipped: 0 },
      { spec_id: SPEC, parse_status: 'ok', n_rows: 1546, n_new: 1546, n_changed: 0, n_skipped: 0 },
    ]);
    expect(alertsOf('hwlw_type_conflict')).toEqual([]);
    expect(alertsOf('hwlw_unlabelled')).toEqual([]);
    expect(await h.count('obs')).toBe(0);
    expect(await h.count('publish_dirty')).toBe(0);
    // A second pass (replay of both lines) writes nothing: no label and no tide row is rewritten.
    expect(await replay(deps(), { ...REPLAY_HW, dryRun: false })).toEqual({
      lines: 2,
      loaded: 2,
      quarantined: 0,
      skipped: 0,
      n_new: 0,
      n_changed: 0,
    });
    expect(await labelRows()).toEqual(labels);
    expect(await tideRows()).toEqual(tide);
  });

  it('an agger list (not alternating) after its type is stored with RWS labels and no hwlw_unlabelled', async () => {
    const type = vlissingenType();
    await typeLine(VL, bytes(type));
    await heightsLine(VL, heightsOf(type, napTemplate(), 11));
    expect(await tick()).toEqual({ lines: 2, loaded: 2 });
    const tide = await tideRows();
    const labels = await labelRows();
    expect(tide).toHaveLength(1546);
    expect(labels).toHaveLength(1546);
    expect(tide.map((r) => r.hilo)).toEqual(labels.map((r) => r.hilo));
    // The agger instant itself carries RWS's word, not a derived one.
    expect(tide[11]?.hilo).toBe(wordAt(11) === 'hoogwater' ? 'high' : 'low');
    expect(alertsOf('hwlw_unlabelled')).toEqual([]);
    expect(alertsOf('hwlw_type_conflict')).toEqual([]);
    expect((await batches()).at(-1)).toMatchObject({ n_rows: 1546, n_new: 1546, n_skipped: 0 });
  });

  it('a planted conflict stores RWS label, counts the conflict, alerts once and leaves n_skipped alone', async () => {
    await typeLine(VL, typeWith({ 20: flipped(20) }));
    await heightsLine(VL, heightsOf(vlissingenType(), napTemplate()));
    expect(await tick()).toEqual({ lines: 2, loaded: 2 });
    const tide = await tideRows();
    // Every row but the 21st agrees with the unflipped type; the 21st has RWS's (flipped) label.
    const expected = listOf(vlissingenType()).MetingenLijst.map((m, i) =>
      (i === 20 ? flipped(20) : m.Meetwaarde.Waarde_Alfanumeriek) === 'hoogwater' ? 'high' : 'low',
    );
    expect(tide.map((r) => r.hilo)).toEqual(expected);
    expect(alertsOf('hwlw_type_conflict')).toEqual([{ code: 'hwlw_type_conflict', fields: { ...IDS, n: 1 } }]);
    expect(alertsOf('hwlw_unlabelled')).toEqual([]);
    expect((await batches()).at(-1)).toMatchObject({ n_rows: 1546, n_new: 1546, n_skipped: 0 });
  });

  it('heights without type rows keep strict alternation; an agger without type rows is hwlw_unlabelled', async () => {
    // Real Goeree heights alone: alternation labels, no tide_label row.
    await heightsLine('goeree.lichteiland/MSL', recorded('nl-1-hwlw-astro-goeree-lichteiland-msl', 'NL-1').body);
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await h.count('tide_label')).toBe(0);
    expect(await tideRows()).toHaveLength(1546);
    expect((await batches()).at(-1)).toMatchObject({ n_rows: 1546, n_skipped: 0 });
    expect(h.alerts).toEqual([]);
    // A synthetic agger alone: all its rows are unlabelled, nothing is stored, the object is kept (n_skipped).
    await heightsLine(VL, heightsOf(vlissingenType(), napTemplate(), 11), LATER(1000));
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await tideRows()).toHaveLength(1546);
    expect((await batches()).at(-1)).toMatchObject({ n_rows: 0, n_new: 0, n_skipped: 1546 });
    expect(h.alerts).toEqual([{ code: 'hwlw_unlabelled', fields: { ...IDS, n: 1546 } }]);
  });

  it('a type that loads after its heights relabels nothing until the next heights line (the ponytail rule)', async () => {
    const heights = heightsOf(vlissingenType(), napTemplate());
    await heightsLine(VL, heights);
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    const alternation = await tideRows();
    // RWS says the opposite for one instant, but arrives after the heights.
    await typeLine(VL, typeWith({ 20: flipped(20) }), LATER(600_000));
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await h.count('tide_label')).toBe(1546);
    expect(await tideRows()).toEqual(alternation);
    expect(alertsOf('hwlw_type_conflict')).toEqual([]);
    // The next heights fetch (the same curve, newer) writes RWS's label for that one row, and alerts the conflict.
    await heightsLine(VL, heights, LATER(1_200_000));
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    const after = await tideRows();
    expect(after.filter((r, i) => r.hilo !== alternation[i]?.hilo)).toHaveLength(1);
    expect(after[20]?.hilo).not.toBe(alternation[20]?.hilo);
    expect((await batches()).at(-1)).toMatchObject({ n_rows: 1546, n_new: 0, n_changed: 1, n_skipped: 0 });
    expect(alertsOf('hwlw_type_conflict')).toEqual([{ code: 'hwlw_type_conflict', fields: { ...IDS, n: 1 } }]);
  });

  it('an agger heights line loaded before its type is loaded by a replay after it: n_skipped falls, the rows are stored', async () => {
    const type = vlissingenType();
    await heightsLine(VL, heightsOf(type, napTemplate(), 11));
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await h.count('tide')).toBe(0);
    expect(await batches()).toMatchObject([{ n_rows: 0, n_new: 0, n_skipped: 1546 }]);
    await typeLine(VL, bytes(type), LATER(600_000));
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await h.count('tide')).toBe(0);
    const r = await replay(deps(), { ...REPLAY_HW, dryRun: false });
    expect(r).toMatchObject({ lines: 2, loaded: 2, quarantined: 0, n_new: 1546, n_changed: 0 });
    expect(await h.count('tide')).toBe(1546);
    expect(await batches()).toMatchObject([
      { n_rows: 1546, n_new: 1546, n_changed: 0, n_skipped: 0 },
      { n_rows: 1546, n_new: 1546, n_changed: 0, n_skipped: 0 },
    ]);
    // And once more: nothing is written.
    const settled = await tideRows();
    expect(await replay(deps(), { ...REPLAY_HW, dryRun: false })).toMatchObject({ n_new: 0, n_changed: 0 });
    expect(await tideRows()).toEqual(settled);
  });

  it('a type value that is neither hoogwater nor laagwater is hwlw_type_unknown: retained, counted, never named', async () => {
    const WORD = 'springvloed-synthetic';
    await typeLine(VL, typeWith({ 3: WORD, 4: WORD }));
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await labelRows()).toHaveLength(1544);
    expect(await batches()).toMatchObject([{ n_rows: 1544, n_new: 1544, n_skipped: 2 }]);
    expect(h.alerts).toEqual([{ code: 'hwlw_type_unknown', fields: { ...IDS, n: 2 } }]);
    expect(JSON.stringify(h.alerts)).not.toContain(WORD);
    // Those two instants have no RWS label: the heights fall back to alternation there.
    await heightsLine(VL, heightsOf(vlissingenType(), napTemplate()));
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await tideRows()).toHaveLength(1546);
    expect(alertsOf('hwlw_type_conflict')).toEqual([]);
  });

  it('tide_label is read by no API role; the owner canary is absent from the public tide view', async () => {
    for (const role of ['rws_api', 'rws_publish', 'rws_owner_api'] as const) {
      const c = await h.t.connectAs(role);
      expect(await sqlState(c, 'SELECT 1 FROM tide_label LIMIT 1'), role).toBe('42501');
    }
    const load = await h.t.connectAs('rws_load');
    expect(await sqlState(load, 'SELECT 1 FROM tide_label LIMIT 1')).toBe('ok');
    expect(await sqlState(load, 'DELETE FROM tide_label')).toBe('42501');
    // The canary's tide row (its series is the owner source's) is in the owner view and in no public one.
    const migrator = h.dbAs('rws_migrator', 1);
    await migrator.db.transaction().execute(async (tx) => {
      await lock(tx);
      await syncOwnerCanary(tx);
    });
    const canary = (await q(`SELECT id FROM series WHERE provider_key = 'owner-canary'`))[0]?.id;
    await q(
      `INSERT INTO tide (series_id, kind, ts, value, hilo, batch_id) VALUES ($1, 'extreme_astro', $2, $3, 'high', 0)`,
      [canary, '2026-10-20T00:00:00Z', CANARIES.owner.value],
    );
    for (const role of ['rws_api', 'rws_publish'] as const) {
      const c = await h.t.connectAs(role);
      const { rows } = await c.query(`SELECT * FROM ${VIEWS.public.tide}`);
      expect(rows, role).toEqual([]);
    }
    const owner = await h.t.connectAs('rws_owner_api');
    expect((await owner.query(`SELECT count(*)::int AS n FROM ${VIEWS.owner.tide}`)).rows).toEqual([{ n: 1 }]);
  });
});
