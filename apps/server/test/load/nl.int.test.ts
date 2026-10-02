import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bareLine, writePayload } from '../../../../scripts/fixture-archive.ts';
import { VIEWS } from '../../src/db/audience.ts';
import { computeHealth } from '../../src/load/health.ts';
import { readRegistry, syncRegistry } from '../../src/load/registry-sync.ts';
import { replay } from '../../src/load/replay.ts';
import { checkTwins } from '../../src/load/twins.ts';
import { rawFixture } from '../adapters/registry.ts';
import { type Harness, harness } from './harness.ts';

// NL-1 through the loader (issue #17, P2b): the recorded RWS payloads load,
// a replay changes nothing, a gap is never stored as 0.0, the withheld values
// keep their payload, and the Eijsden-grens twin is checked.

let h: Harness;
const TWIN = 'eijsden-grens-taw-nap';
const NAP = 'eijsden.grens/WATHTE/NAP/other:F007';
const TAW = 'eijsden.grens/WATHTE/TAW/other:F007';
/** Fetched 2026-09-30T15:49:46Z; the pair's values run from 12:50Z to 15:30Z. */
const AFTER = new Date('2026-09-30T17:10:00Z');

async function put(spec: string, name: string, variant: string, change?: { at: Date; body: Buffer }) {
  const f = rawFixture('NL-1', name);
  return writePayload(h.archive, {
    source: 'NL-1',
    spec,
    variant,
    at: change?.at ?? new Date(f.meta.recorded_at),
    body: change?.body ?? f.body,
    url: f.meta.url,
  });
}
const tick = () => h.loader({ now: AFTER }).tick();
const check = async () => {
  const { rows } = await h.t.admin.query(
    'SELECT window_end, n_aligned, median_delta, max_delta, lag_min, ok FROM twin_check WHERE twin_id = $1 ORDER BY window_end',
    [TWIN],
  );
  return rows;
};
/** The TAW payload with its first value (12:50Z, 4642) replaced. */
const tawWith = (value: number) => {
  const doc = JSON.parse(rawFixture('NL-1', 'nl-1-obs-twin').body.toString('utf8'));
  doc.WaarnemingenLijst[0].MetingenLijst[0].Meetwaarde = { Waarde_Alfanumeriek: String(value), Waarde_Numeriek: value };
  return Buffer.from(JSON.stringify(doc));
};

beforeAll(async () => {
  h = await harness();
});

afterAll(async () => {
  await h.close();
});

// A registry sync writes about 1,700 series since P5a (seconds on a CI runner); some tests here sync twice.
describe('NL-1 observations', { timeout: 60_000 }, () => {
  it('loads the recorded payloads; a 204 is a fetch that worked, not a payload', async () => {
    await put('nl-1-obs-key', 'nl-1-obs-key', 'lobith.bovenrijn.tolkamer/H');
    await put('nl-1-obs-key', 'nl-1-obs-key-eijsden-grens-h', 'eijsden.grens/H');
    await put('nl-1-obs-other', 'nl-1-obs-other-lobith-bovenrijn-tolkamer-q', 'lobith.bovenrijn.tolkamer/Q');
    await put('nl-1-obs-other', 'nl-1-obs-other-driel-boven-q', 'driel.boven/Q');
    // The recorded "no data" answer of arnhem.nederrijn Q: status 204, no object.
    await h.archive.append(
      bareLine('NL-1', 'nl-1-obs-other', new Date('2026-09-30T15:49:46Z'), {
        status: 204,
        variant: 'arnhem.nederrijn/Q',
        validity: { ok: true, reason: null, count: 0 },
      }),
    );
    expect(await tick()).toEqual({ lines: 5, loaded: 4 });
    expect(h.alerts).toEqual([]);
    expect(await h.count('ingest_batch')).toBe(4);
    expect(await h.count('obs')).toBe(16 + 17 + 35);
    const { rows } = await h.t.admin.query(
      `SELECT spec_id, parse_status, n_rows, n_new, n_skipped, error FROM ingest_batch ORDER BY id`,
    );
    expect(rows).toEqual([
      { spec_id: 'nl-1-obs-key', parse_status: 'ok', n_rows: 16, n_new: 16, n_skipped: 0, error: null },
      { spec_id: 'nl-1-obs-key', parse_status: 'ok', n_rows: 17, n_new: 17, n_skipped: 0, error: null },
      { spec_id: 'nl-1-obs-other', parse_status: 'ok', n_rows: 35, n_new: 35, n_skipped: 0, error: null },
      // Driel Q: 35 gaps (quality code 99) on a series we never store.
      { spec_id: 'nl-1-obs-other', parse_status: 'ok', n_rows: 0, n_new: 0, n_skipped: 0, error: null },
    ]);
    const health = await h.t.admin.query(
      "SELECT last_fetch_ok, consecutive_failures, newest_ts FROM source_health WHERE source_id = 'NL-1'",
    );
    expect(health.rows).toEqual([
      {
        last_fetch_ok: new Date('2026-09-30T15:49:46Z'),
        consecutive_failures: 0,
        newest_ts: new Date('2026-09-30T15:30:00Z'),
      },
    ]);
  });

  it('RWS 99/0.0 never appears as a value', async () => {
    expect((await h.t.admin.query('SELECT count(*)::int AS n FROM obs WHERE value = 0')).rows).toEqual([{ n: 0 }]);
    const driel = await h.t.admin.query(
      "SELECT count(*)::int AS n FROM series WHERE provider_key LIKE 'driel.boven/Q/%'",
    );
    expect(driel.rows).toEqual([{ n: 0 }]);
  });

  it('the twin is not checked before both sides have data: a pair never checked gets no row', async () => {
    expect(await checkTwins(h.load.db, AFTER)).toEqual([]);
    expect(await check()).toEqual([]);
  });

  it('TAW − NAP is 233 cm on every timestamp both series have', async () => {
    await put('nl-1-obs-twin', 'nl-1-obs-twin', 'eijsden.grens/H');
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await checkTwins(h.load.db, AFTER)).toEqual([]);
    expect(await check()).toEqual([
      {
        window_end: new Date('2026-09-30T17:00:00Z'),
        n_aligned: 17,
        median_delta: 233,
        max_delta: 233,
        // P5b: the lag is measured (0: none); it stays NULL only when nothing aligned.
        lag_min: 0,
        ok: true,
      },
    ]);
    // The newest half hour before the window's end is left to settle: at 15:55Z the window ends at 15:00Z
    // and holds 12:50Z … 14:30Z.
    expect(await checkTwins(h.load.db, new Date('2026-09-30T15:55:00Z'))).toEqual([]);
    expect((await check())[0]).toMatchObject({ window_end: new Date('2026-09-30T15:00:00Z'), n_aligned: 11, ok: true });
    // The same pass again writes the same row.
    await checkTwins(h.load.db, AFTER);
    expect(await check()).toHaveLength(2);
  });

  it('the public reader sees the check, the twin series itself stays out of the series views', async () => {
    const api = await h.t.connectAs('rws_api');
    const checks = await api.query(`SELECT twin_id, ok FROM ${VIEWS.public.twinCheck} ORDER BY window_end`);
    expect(checks.rows).toEqual([
      { twin_id: TWIN, ok: true },
      { twin_id: TWIN, ok: true },
    ]);
    const series = await api.query(
      `SELECT id, datum FROM ${VIEWS.public.series} WHERE station_id = 'nl.rws.eijsden.grens' AND quantity = 'H'`,
    );
    expect(series.rows).toEqual([{ id: await h.seriesId(NAP), datum: 'NAP' }]);
  });

  it('replaying NL-1 changes nothing: the same checksums, no new row, no revision', async () => {
    const before = { sums: await h.checksums(), obs: await h.count('obs'), rev: await h.count('obs_revision') };
    const result = await replay(
      {
        db: h.load.db,
        reader: h.reader,
        alert: (code, fields = {}) => h.alerts.push({ code, fields }),
        now: () => AFTER,
      },
      { source: 'NL-1', spec: null, from: '2026-09-01', to: '2026-12-31', dryRun: false },
    );
    expect(result).toEqual({ lines: 5, loaded: 5, quarantined: 0, skipped: 0, n_new: 0, n_changed: 0 });
    expect({ sums: await h.checksums(), obs: await h.count('obs'), rev: await h.count('obs_revision') }).toEqual(
      before,
    );
    expect(before.rev).toBe(0);
    expect(h.alerts).toEqual([]);
  });

  it('a breach: one side 3 cm off fails the check once, and a corrected value clears it', async () => {
    await put('nl-1-obs-twin', 'nl-1-obs-twin', 'eijsden.grens/H', {
      at: new Date('2026-09-30T16:00:00Z'),
      body: tawWith(4645),
    });
    await tick();
    expect(await h.count('obs_revision')).toBe(1);
    // The check turned from ok to failing: reported once, not on every pass.
    expect(await checkTwins(h.load.db, AFTER)).toEqual([TWIN]);
    expect(await checkTwins(h.load.db, AFTER)).toEqual([]);
    expect((await check()).at(-1)).toEqual({
      window_end: new Date('2026-09-30T17:00:00Z'),
      n_aligned: 17,
      median_delta: 233,
      max_delta: 236,
      lag_min: 0,
      ok: false,
    });
    // A new hour with the pair still failing reports it again.
    expect(await checkTwins(h.load.db, new Date('2026-09-30T18:10:00Z'))).toEqual([TWIN]);
    // Within the tolerance of 1 cm is fine.
    await put('nl-1-obs-twin', 'nl-1-obs-twin', 'eijsden.grens/H', {
      at: new Date('2026-09-30T16:10:00Z'),
      body: tawWith(4643),
    });
    await tick();
    expect(await checkTwins(h.load.db, AFTER)).toEqual([]);
    expect((await check()).find((r) => r.window_end.getTime() === Date.parse('2026-09-30T17:00:00Z'))).toMatchObject({
      max_delta: 234,
      ok: true,
    });
  });

  it('withheld values keep their payload for a replay, and each kind raises its alert', async () => {
    h.alerts.length = 0;
    await put('nl-1-obs-key', 'nl-1-obs-split.synthetic', 'eijsden.grens/H');
    await tick();
    const { rows } = await h.t.admin.query('SELECT parse_status, n_skipped FROM ingest_batch ORDER BY id DESC LIMIT 1');
    // The values withheld: unit 2, method 4 (2 Eijsden values, and the 2 maaseik Q values under F103: since P5a
    // maaseik Q is registered with its live method F006, so the list is no longer an unregistered series), quality
    // code 1, conflict 3, and registered_dropped 4 (the lists under the registered Eijsden NAP key with ProcesType
    // verwachting (2 values), Groepering GETETM2 (1) and compartment BS (1)): 2 + 4 + 1 + 3 + 4 = 14.
    expect(rows).toEqual([{ parse_status: 'ok', n_skipped: 14 }]);
    const ids = { source: 'NL-1', spec: 'nl-1-obs-key' };
    expect(h.alerts).toEqual([
      { code: 'unit_mismatch', fields: { ...ids, n: 2 } },
      { code: 'unregistered_method', fields: { ...ids, n: 4 } },
      { code: 'unknown_quality', fields: { ...ids, n: 1 } },
      { code: 'conflict', fields: { ...ids, n: 3 } },
      { code: 'registered_dropped', fields: { ...ids, n: 4 } },
    ]);
    // The gap, the unreadable code and the conflicting instant did not overwrite what was stored.
    const nap = await h.t.admin.query(
      `SELECT o.ts, o.value FROM obs o JOIN series s ON s.id = o.series_id
       WHERE s.provider_key = $1 AND o.ts BETWEEN '2026-09-30T14:40:00Z' AND '2026-09-30T15:00:00Z' ORDER BY o.ts`,
      [NAP],
    );
    expect(nap.rows.map((r) => r.value)).not.toContain(0);
    expect(nap.rows.map((r) => r.value)).not.toContain(9999);
    expect(nap.rows).toHaveLength(3);
  });

  it('the registry sync owns the pair: a pair that leaves the registry is no longer checked', async () => {
    // P5b: the registry holds seven public pairs (registry/twins.yaml) and, from P5c, the generated owner pairs
    // (registry/twins/*.yaml); this test follows the Eijsden one.
    const twin = await h.t.admin.query('SELECT id, relation FROM twin WHERE id = $1', [TWIN]);
    expect(twin.rows).toEqual([{ id: TWIN, relation: { kind: 'offset', expected: 233, tolerance: 1, unit: 'cm' } }]);
    expect(await h.count('twin')).toBe(readRegistry().twins.length);
    const sides = await h.t.admin.query(
      `SELECT a.provider_key AS a, b.provider_key AS b, a.role AS a_role, b.role AS b_role
       FROM twin t JOIN series a ON a.id = t.series_a JOIN series b ON b.id = t.series_b WHERE t.id = $1`,
      [TWIN],
    );
    expect(sides.rows).toEqual([{ a: TAW, b: NAP, a_role: 'twin', b_role: 'primary' }]);
    const owner = h.dbAs('rws_migrator', 1);
    const input = readRegistry();
    expect((await syncRegistry(owner.db, input)).twins).toBe(input.twins.length);
    expect((await syncRegistry(owner.db, { ...input, twins: [] })).twins).toBe(0);
    expect((await h.t.admin.query('SELECT relation FROM twin WHERE id = $1', [TWIN])).rows).toEqual([{ relation: {} }]);
    const checks = (await check()).length;
    expect(await checkTwins(h.load.db, new Date('2026-09-30T19:10:00Z'))).toEqual([]);
    expect(await check()).toHaveLength(checks);
    // Its checks stay, and the pair comes back with the registry.
    await syncRegistry(owner.db, input);
    expect((await h.t.admin.query("SELECT relation->>'kind' AS kind FROM twin WHERE id = $1", [TWIN])).rows).toEqual([
      { kind: 'offset' },
    ]);
  });

  it('a stale series is the provider’s when the spec that fetches it stated it within two of its own cadences', async () => {
    // Lobith Q is fetched every 30 minutes. At 16:50Z RWS still serves 15:30Z as its newest value.
    await put('nl-1-obs-other', 'nl-1-obs-other-lobith-bovenrijn-tolkamer-q', 'lobith.bovenrijn.tolkamer/Q', {
      at: new Date('2026-09-30T16:50:00Z'),
      body: rawFixture('NL-1', 'nl-1-obs-other-lobith-bovenrijn-tolkamer-q').body,
    });
    await tick();
    const now = new Date('2026-09-30T17:15:00Z');
    const tier1 = async (specCadenceS?: Map<string, number>) => {
      await computeHealth(h.load.db, {
        cadenceS: new Map([['NL-1', 600]]),
        ...(specCadenceS ? { specCadenceS } : {}),
        lagP95Ms: new Map(),
        backlog: { files: 0, bytes: 0, age_s: null },
        badLines: 0,
        now,
      });
      const { rows } = await h.t.admin.query("SELECT detail FROM source_health WHERE source_id = 'NL-1'");
      return rows[0]?.detail.tier1;
    };
    // Its newest value is 105 minutes old (limit 90): stale. Stated 25 minutes ago: inside two 30-minute
    // cadences, outside two of the source's shortest (10 minutes).
    expect(await tier1()).toEqual({ total: 41, fresh: 0, provider_stale: 0 });
    const specs = new Map([
      ['nl-1-obs-key', 600],
      ['nl-1-obs-other', 1800],
      ['nl-1-obs-twin', 600],
    ]);
    expect(await tier1(specs)).toEqual({ total: 41, fresh: 0, provider_stale: 1 });
  });

  // Last, because it loads a day later: the tests above count fresh series at 2026-09-30T17:15Z.
  it('a checked pair whose values stop aligning fails with 0 aligned, once per hour, and is ok when they align again', async () => {
    // A day on, nothing either side stated falls in the window that ends at 2026-10-01T16:00Z.
    const LATER = new Date('2026-10-01T16:10:00Z');
    expect(await checkTwins(h.load.db, LATER)).toEqual([TWIN]);
    expect(await checkTwins(h.load.db, LATER)).toEqual([]);
    const failing = {
      window_end: new Date('2026-10-01T16:00:00Z'),
      n_aligned: 0,
      median_delta: null,
      max_delta: null,
      lag_min: null,
      ok: false,
    };
    expect((await check()).at(-1)).toEqual(failing);
    // The public reader sees it failing, not the last ok check.
    const api = await h.t.connectAs('rws_api');
    const latest = await api.query(
      `SELECT n_aligned, ok FROM ${VIEWS.public.twinCheck} WHERE twin_id = $1 ORDER BY window_end DESC LIMIT 1`,
      [TWIN],
    );
    expect(latest.rows).toEqual([{ n_aligned: 0, ok: false }]);
    // A pair whose relation the registry sync cleared gets no row, checked before or not.
    const owner = h.dbAs('rws_migrator', 1);
    const input = readRegistry();
    await syncRegistry(owner.db, { ...input, twins: [] });
    const checks = (await check()).length;
    expect(await checkTwins(h.load.db, new Date('2026-10-01T17:10:00Z'))).toEqual([]);
    expect(await check()).toHaveLength(checks);
    await syncRegistry(owner.db, input);
    // Both sides again, recorded a day later: the same hour's check turns ok, and that is no breach.
    const dayLater = (name: string) =>
      Buffer.from(rawFixture('NL-1', name).body.toString('utf8').replaceAll('2026-09-30T', '2026-10-01T'));
    const at = new Date('2026-10-01T15:49:46Z');
    await put('nl-1-obs-key', 'nl-1-obs-key-eijsden-grens-h', 'eijsden.grens/H', {
      at,
      body: dayLater('nl-1-obs-key-eijsden-grens-h'),
    });
    await put('nl-1-obs-twin', 'nl-1-obs-twin', 'eijsden.grens/H', { at, body: dayLater('nl-1-obs-twin') });
    expect(await h.loader({ now: LATER }).tick()).toEqual({ lines: 2, loaded: 2 });
    expect(await checkTwins(h.load.db, LATER)).toEqual([]);
    expect((await check()).at(-1)).toEqual({
      ...failing,
      n_aligned: 17,
      median_delta: 233,
      max_delta: 233,
      lag_min: 0,
      ok: true,
    });
  });
});
