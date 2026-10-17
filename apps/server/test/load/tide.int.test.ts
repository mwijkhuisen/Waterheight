import { emptyNormalised, type TideRowIn } from '@rws/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recorded, writePayload } from '../../../../scripts/fixture-archive.ts';
import { VIEWS } from '../../src/db/audience.ts';
import type { LoadAdapter } from '../../src/load/adapters.ts';
import { replay } from '../../src/load/replay.ts';
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
