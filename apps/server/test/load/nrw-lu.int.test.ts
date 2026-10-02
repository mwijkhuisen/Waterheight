import { unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNrwLuFixtureArchive, recorded, writePayload } from '../../../../scripts/fixture-archive.ts';
import { HYDRO_MEMBER } from '../../src/adapters/de-8/parse.ts';
import { OBS_AT, VIEWS } from '../../src/db/audience.ts';
import { offsetKey } from '../../src/load/label-offset.ts';
import { replay } from '../../src/load/replay.ts';
import { type Harness, harness } from './harness.ts';

// DE-7, DE-8, LU-1 and LU-6 through the loader (issue #20, P5b), on the recorded fixtures: every payload loads, DE-7
// reads its +01:00 stamps as UTC, the placeholder gauge has no series, DE-8's gauge zero reaches the DE-7 series and
// is never overwritten by another payload, a 239k-row seed loads in one batch and a payload that re-states it
// takes only its window, a replay writes nothing, LU-1's twin and its off gauge reach no reader and its labels
// follow the measured offset through a replay (with revisions), and the station files report their drift.

let h: Harness;
const AFTER = new Date('2026-10-02T12:00:00Z');
const STAH = '2829100000100/W';
const deps = (x: Harness) => ({
  db: x.load.db,
  reader: x.reader,
  alert: (code: string, fields: Record<string, string | number> = {}) => x.alerts.push({ code, fields }),
  now: () => AFTER,
});

/** The stored rows of one series (by source and key), in time order. */
async function rows(x: Harness, source: string, key: string) {
  const { rows: r } = await x.t.admin.query<{ ts: Date; value: number; qc: number }>(
    `SELECT o.ts, o.value, o.qc FROM obs o JOIN series s ON s.id = o.series_id
     WHERE s.source_id = $1 AND s.provider_key = $2 ORDER BY o.ts`,
    [source, key],
  );
  return r;
}

async function seriesId(x: Harness, source: string, key: string): Promise<number> {
  const { rows: r } = await x.t.admin.query<{ id: number }>(
    'SELECT id FROM series WHERE source_id = $1 AND provider_key = $2',
    [source, key],
  );
  if (r[0] === undefined) throw new Error(`no series ${source} ${key}`);
  return r[0].id;
}

const batches = async (x: Harness) =>
  (
    await x.t.admin.query(
      `SELECT id, source_id, spec_id, parse_status, n_rows, n_new, n_changed, n_skipped, error FROM ingest_batch ORDER BY id`,
    )
  ).rows;

const appMeta = async (x: Harness, key: string) =>
  (await x.t.admin.query<{ value: Record<string, unknown> }>('SELECT value FROM app_meta WHERE key = $1', [key]))
    .rows[0]?.value;

beforeAll(async () => {
  h = await harness();
});

afterAll(async () => {
  await h.close();
});

describe('the DE-7, DE-8, LU-1 and LU-6 fixtures', { timeout: 60_000 }, () => {
  it('load: every payload ok, nothing quarantined, no alert', async () => {
    // The P1a recording of LU-1 is the old 5-day format, whose labels are 15 minutes late (the 7-day format of
    // 2026-09-30 on is on time, and a day without a measurement takes 0). A measured day of the old format is
    // carried forward to the days of the recording, as the nightly detector would have left it.
    await h.t.admin.query('INSERT INTO app_meta (key, value) VALUES ($1, $2::jsonb)', [
      offsetKey('LU-1'),
      JSON.stringify({ days: { '2026-09-20': { decided: true, minutes: 15, n_aligned: 34, share: 1 } } }),
    ]);
    const lines = await buildNrwLuFixtureArchive(h.raw);
    const r = await h.loader({ now: AFTER }).tick();
    expect(r).toEqual({ lines: lines.length, loaded: lines.length });
    expect(h.alerts).toEqual([]);
    const { rows: counts } = await h.t.admin.query(
      `SELECT source_id, parse_status, count(*)::int AS n FROM ingest_batch GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    expect(counts).toEqual([
      { source_id: 'DE-7', parse_status: 'ok', n: 1 },
      { source_id: 'DE-8', parse_status: 'ok', n: 2 },
      { source_id: 'LU-1', parse_status: 'ok', n: 1 },
      { source_id: 'LU-6', parse_status: 'ok', n: 1 },
    ]);
  });

  it('DE-7: the +01:00 stamps are read as UTC, the placeholder gauge has no series and no row', async () => {
    const stah = await rows(h, 'DE-7', STAH);
    expect(stah).toHaveLength(672);
    // 2026-09-22T14:45:00.000+01:00 is 13:45Z; the last stamp 2026-09-29T14:30:00.000+01:00 is 13:30Z.
    expect(stah[0]?.ts.toISOString()).toBe('2026-09-22T13:45:00.000Z');
    expect(stah[0]?.value).toBe(34);
    expect(stah.at(-1)?.ts.toISOString()).toBe('2026-09-29T13:30:00.000Z');
    expect(stah.at(-1)?.value).toBe(29);
    const { rows: placeholder } = await h.t.admin.query(
      `SELECT count(*)::int AS n FROM series WHERE provider_key LIKE '1234512345%'`,
    );
    expect(placeholder).toEqual([{ n: 0 }]);
    // The five gauges of the trimmed recording: 2,013 + 4 × 672 rows; the 670 placeholder rows were dropped.
    const { rows: stored } = await h.t.admin.query(
      `SELECT count(*)::int AS n FROM obs o JOIN series s ON s.id = o.series_id WHERE s.source_id = 'DE-7'`,
    );
    expect(stored).toEqual([{ n: 2013 + 4 * 672 }]);
    const b = (await batches(h)).find((x) => x.source_id === 'DE-7');
    expect(b).toMatchObject({ n_rows: 2013 + 4 * 672, n_new: 2013 + 4 * 672, n_changed: 0, n_skipped: 0, error: null });
  });

  it('DE-8 hydro: the gauge zero of Stah reaches the DE-7 series (29.938 m NHN, no validity date)', async () => {
    const { rows: zero } = await h.t.admin.query(
      `SELECT g.value_m, g.datum, lower(g.valid) AS valid_from, upper_inf(g.valid) AS open, g.batch_id,
              s.source_id, s.provider_key
       FROM gauge_zero g JOIN series s ON s.id = g.series_id WHERE s.provider_key = $1`,
      [STAH],
    );
    expect(zero).toHaveLength(1);
    expect(zero[0]).toMatchObject({
      value_m: 29.938,
      datum: 'NHN',
      valid_from: null,
      open: true,
      source_id: 'DE-7',
    });
    const hydro = (await batches(h)).find((x) => x.spec_id === 'de-8-hydro');
    expect(zero[0]?.batch_id).toBe(hydro?.id);
    // 219 of the registered gauges are in the hydro file (the other 32 have no zero).
    const { rows: n } = await h.t.admin.query(
      `SELECT count(*)::int AS n FROM gauge_zero g JOIN series s ON s.id = g.series_id WHERE s.source_id = 'DE-7'`,
    );
    expect(n[0]?.n).toBeGreaterThan(200);
    expect(hydro?.n_rows).toBe(n[0]?.n);
  });

  it('a replay of DE-7, DE-8, LU-1 and LU-6, twice, writes nothing', async () => {
    const before = {
      sums: await h.checksums(),
      revisions: await h.count('obs_revision'),
      batches: await batches(h),
      zeros: (await h.t.admin.query('SELECT series_id, value_m, datum, valid, batch_id FROM gauge_zero ORDER BY 1'))
        .rows,
    };
    for (let pass = 0; pass < 2; pass += 1) {
      for (const source of ['DE-7', 'DE-8', 'LU-1', 'LU-6']) {
        const r = await replay(deps(h), { source, spec: null, from: '2026-09-01', to: '2026-12-31', dryRun: false });
        expect({
          source,
          quarantined: r.quarantined,
          skipped: r.skipped,
          n_new: r.n_new,
          n_changed: r.n_changed,
        }).toEqual({ source, quarantined: 0, skipped: 0, n_new: 0, n_changed: 0 });
        expect(r.lines).toBeGreaterThan(0);
      }
    }
    expect(h.alerts).toEqual([]);
    expect({
      sums: await h.checksums(),
      revisions: await h.count('obs_revision'),
      batches: await batches(h),
      zeros: (await h.t.admin.query('SELECT series_id, value_m, datum, valid, batch_id FROM gauge_zero ORDER BY 1'))
        .rows,
    }).toEqual(before);
    expect(before.revisions).toBe(0);
  });

  it('LU-1: Diekirch sits at label − 15 min; the Perl twin is stored and shown nowhere; Bollendorf and Esch-Sure store nothing', async () => {
    const diekirch = await rows(h, 'LU-1', 'Diekirch');
    expect(diekirch).toHaveLength(96);
    // 28.09.2026 15:45 Luxembourg time (CEST, +02:00) is 13:45Z; the measured offset of the old format is 15 minutes.
    expect(diekirch[0]?.ts.toISOString()).toBe('2026-09-28T13:30:00.000Z');
    expect(diekirch[0]?.value).toBeCloseTo(120.1, 4);
    expect(diekirch.at(-1)?.ts.toISOString()).toBe('2026-09-29T13:15:00.000Z');

    const perl = await rows(h, 'LU-1', 'Perl');
    expect(perl).toHaveLength(96);
    expect(perl[0]?.value).toBeCloseTo(214, 4);
    // Bollendorf is an off station of a public source; Esch-Sure's row is wider than the header (row_width).
    for (const key of ['Bollendorf', 'Esch-Sure']) expect(await rows(h, 'LU-1', key), key).toEqual([]);
    const ids = {
      perl: await seriesId(h, 'LU-1', 'Perl'),
      bollendorf: await seriesId(h, 'LU-1', 'Bollendorf'),
      diekirch: await seriesId(h, 'LU-1', 'Diekirch'),
    };
    expect((await h.t.admin.query('SELECT role, audience FROM series WHERE id = $1', [ids.perl])).rows).toEqual([
      { role: 'twin', audience: null },
    ]);
    const { rows: held } = await h.t.admin.query(
      `SELECT (SELECT count(*)::int FROM obs_latest WHERE series_id = $1) AS latest,
              (SELECT count(*)::int FROM obs_1h WHERE series_id = $1) AS h1,
              (SELECT count(*)::int FROM obs_1d WHERE series_id = $1) AS d1`,
      [ids.bollendorf],
    );
    expect(held).toEqual([{ latest: 0, h1: 0, d1: 0 }]);
    // The batch counts what it stored: the four series that share the source's audience (a gap is no row).
    const { rows: stored } = await h.t.admin.query(
      `SELECT count(*)::int AS n FROM obs o JOIN series s ON s.id = o.series_id WHERE s.source_id = 'LU-1'`,
    );
    expect(stored[0]?.n).toBeGreaterThan(300);
    expect((await batches(h)).find((x) => x.source_id === 'LU-1')).toMatchObject({
      n_rows: stored[0]?.n,
      n_new: stored[0]?.n,
    });

    // No view of either family shows the twin or the off gauge; Diekirch is the positive control.
    const at = "'2026-09-29T13:40:00Z'::timestamptz";
    for (const [role, family, fn] of [
      ['rws_api', VIEWS.public, OBS_AT.public],
      ['rws_owner_api', VIEWS.owner, OBS_AT.owner],
    ] as const) {
      const client = await h.t.connectAs(role);
      const seen = async (sql: string) =>
        new Set((await client.query<{ series_id: number }>(sql)).rows.map((r) => r.series_id));
      const queries = {
        obs: `SELECT DISTINCT series_id FROM ${family.obs}`,
        latest: `SELECT DISTINCT series_id FROM ${family.obsLatest}`,
        h1: `SELECT DISTINCT series_id FROM ${family.obs1h}`,
        d1: `SELECT DISTINCT series_id FROM ${family.obs1d}`,
        apiObs: `SELECT DISTINCT series_id FROM ${family.api.obs}`,
        apiH1: `SELECT DISTINCT series_id FROM ${family.api.obs1h}`,
        apiD1: `SELECT DISTINCT series_id FROM ${family.api.obs1d}`,
        series: `SELECT id AS series_id FROM ${family.series}`,
        apiSeries: `SELECT id AS series_id FROM ${family.api.series}`,
        at: `SELECT series_id FROM ${fn}(${at})`,
      };
      for (const [name, sql] of Object.entries(queries)) {
        const ids_ = await seen(sql);
        expect(ids_.has(ids.diekirch), `${role} ${name} shows Diekirch`).toBe(true);
        expect(ids_.has(ids.perl), `${role} ${name} shows the Perl twin`).toBe(false);
        expect(ids_.has(ids.bollendorf), `${role} ${name} shows Bollendorf`).toBe(false);
      }
    }
  });

  it('the measured label offset reaches the rows through a replay: 0 minutes moves Diekirch 15 minutes later, with revisions', async () => {
    // An undecided day (review CR-4) is no offset: 2026-09-27 keeps the 15 minutes carried forward from 09-20.
    const days = {
      '2026-09-20': { decided: true, minutes: 15, n_aligned: 34, share: 1 },
      '2026-09-27': { decided: false, n_aligned: 3 },
      '2026-09-28': { decided: true, minutes: 0, n_aligned: 34, share: 1 },
      '2026-09-29': { decided: true, minutes: 0, n_aligned: 25, share: 1 },
    };
    await h.t.admin.query('UPDATE app_meta SET value = $2::jsonb WHERE key = $1', [
      offsetKey('LU-1'),
      JSON.stringify({ days }),
    ]);
    const diekirch = await seriesId(h, 'LU-1', 'Diekirch');
    const before = await rows(h, 'LU-1', 'Diekirch');
    const total = async () =>
      (
        await h.t.admin.query(
          `SELECT count(*)::int AS n FROM obs o JOIN series s ON s.id = o.series_id WHERE s.source_id = 'LU-1'`,
        )
      ).rows[0]?.n;
    const stored = await total();
    const r = await replay(deps(h), {
      source: 'LU-1',
      spec: null,
      from: '2026-09-01',
      to: '2026-12-31',
      dryRun: false,
    });
    expect(r).toMatchObject({ lines: 1, loaded: 1, quarantined: 0, skipped: 0 });
    // Each series gets a new row at its last label (now at 13:30Z) and most others change.
    expect(r.n_new).toBeGreaterThanOrEqual(4);
    expect(await total()).toBe(stored + r.n_new);
    expect(r.n_changed).toBeGreaterThan(100);
    expect(h.alerts).toEqual([]);

    const after = await rows(h, 'LU-1', 'Diekirch');
    const at = (list: typeof after, iso: string) => list.find((x) => x.ts.toISOString() === iso)?.value;
    // The first label (15:45 local, 13:45Z) now holds the first value; before it held the value of the second label.
    expect(at(after, '2026-09-28T13:45:00.000Z')).toBeCloseTo(120.1, 4);
    expect(at(before, '2026-09-28T13:45:00.000Z')).toBeCloseTo(119.8, 4);
    // The last label (29.09.2026 15:30 local, 13:30Z) is a new point.
    expect(at(before, '2026-09-29T13:30:00.000Z')).toBeUndefined();
    expect(at(after, '2026-09-29T13:30:00.000Z')).toBeDefined();
    // The move is never silent: each changed point is an obs_revision row.
    const { rows: revisions } = await h.t.admin.query<{ ts: Date; old_value: number; new_value: number }>(
      `SELECT ts, old_value, new_value FROM obs_revision WHERE series_id = $1 ORDER BY ts`,
      [diekirch],
    );
    expect(revisions.length).toBeGreaterThan(50);
    expect(revisions[0]).toMatchObject({ ts: new Date('2026-09-28T13:45:00Z') });
    expect(revisions[0]?.old_value).toBeCloseTo(119.8, 4);
    expect(revisions[0]?.new_value).toBeCloseTo(120.1, 4);
    expect(await h.count('obs_revision')).toBe(r.n_changed);
  });

  it('the station files report their drift against the registry they feed: DE-8 against DE-7, LU-6 against LU-1', async () => {
    // The key is the payload's source, as for NL-2 (registry_drift:NL-2 reports against NL-1).
    const de = await appMeta(h, 'registry_drift:DE-8');
    expect(de).toMatchObject({ spec: 'de-8-stations', vanished: [], changed: [] });
    // The master lists 254 stations, the registry 251 gauges and the placeholder has no series: the two stations
    // of the master without a reading in the recording.
    expect(de?.unregistered).toEqual(['2766929300099', '2825320000100']);
    const lu = await appMeta(h, 'registry_drift:LU-6');
    expect(lu).toMatchObject({ spec: 'lu-6-geo', vanished: [], changed: [] });
    // In-service LU-6 points (fiche numbers) with no registered LU-1 station within 50 m: stations the CSV does not carry.
    expect(lu?.unregistered).toEqual(['101', '104', '105', '106', '46', '47', '48', '49']);
  });

  it('another gauge zero for a series that has one without a validity date is withheld, not written (alert gauge_zero_withheld)', async () => {
    const f = recorded('de-8-hydro', 'DE-8');
    const files = unzipSync(new Uint8Array(f.body));
    expect(Object.keys(files)).toEqual([HYDRO_MEMBER]);
    const text = Buffer.from(files[HYDRO_MEMBER] as Uint8Array).toString('latin1');
    const edited = text.replace(/^(Stah;2829100000100;.*;)29\.938(;Wassenberg;)/m, '$130.938$2');
    expect(edited).not.toBe(text);
    const body = Buffer.from(zipSync({ [HYDRO_MEMBER]: new Uint8Array(Buffer.from(edited, 'latin1')) }));
    const before = (
      await h.t.admin.query(
        'SELECT g.value_m, g.datum, g.valid, g.batch_id FROM gauge_zero g JOIN series s ON s.id = g.series_id WHERE s.provider_key = $1',
        [STAH],
      )
    ).rows;
    h.alerts.length = 0;
    await writePayload(h.archive, {
      source: 'DE-8',
      spec: 'de-8-hydro',
      variant: '',
      at: new Date('2026-10-03T11:11:11Z'),
      body,
      url: f.url,
      retention: 'forever',
    });
    expect(await h.loader({ now: new Date('2026-10-03T12:00:00Z') }).tick()).toEqual({ lines: 1, loaded: 1 });
    // Only Stah differs: the others are confirmations.
    expect(h.alerts).toEqual([{ code: 'gauge_zero_withheld', fields: { source: 'DE-8', spec: 'de-8-hydro', n: 1 } }]);
    const after = (
      await h.t.admin.query(
        'SELECT g.value_m, g.datum, g.valid, g.batch_id FROM gauge_zero g JOIN series s ON s.id = g.series_id WHERE s.provider_key = $1',
        [STAH],
      )
    ).rows;
    expect(after).toEqual(before);
    expect(after[0]?.value_m).toBe(29.938);
  });
});

describe('the full DE-7 recording', { timeout: 300_000 }, () => {
  it('a 238,931-line seed loads in one batch, and the same body fetched an hour later takes only its window', async () => {
    const x = await harness();
    try {
      const f = recorded('de-7-messwerte', 'DE-7');
      const send = (at: Date, seed: boolean) =>
        writePayload(x.archive, {
          source: 'DE-7',
          spec: 'de-7-messwerte',
          variant: '',
          at,
          body: f.body,
          url: f.url,
          ...(seed ? { seed: true as const } : {}),
        });

      await send(f.at, true);
      const started = performance.now();
      expect(await x.loader({ now: AFTER }).tick()).toEqual({ lines: 1, loaded: 1 });
      const seconds = (performance.now() - started) / 1000;
      expect(x.alerts).toEqual([]);

      const [seed] = await batches(x);
      expect(seed).toMatchObject({ source_id: 'DE-7', parse_status: 'ok', n_changed: 0, n_skipped: 0 });
      const { rows: stored } = await x.t.admin.query<{ n: number; series: number }>(
        `SELECT count(*)::int AS n, count(DISTINCT series_id)::int AS series FROM obs WHERE batch_id = $1`,
        [seed?.id],
      );
      expect(seed?.n_rows).toBe(stored[0]?.n);
      expect(seed?.n_new).toBe(seed?.n_rows);
      expect(stored[0]?.n).toBeGreaterThan(200_000);
      // 252 stations in the file, minus the placeholder block.
      expect(stored[0]?.series).toBe(251);
      console.log(
        `DE-7 seed: 238,931 lines (881,400 B zip), ${stored[0]?.n} rows of ${stored[0]?.series} series in one batch, loaded in ${seconds.toFixed(1)} s`,
      );
      expect(await x.count('obs')).toBe(stored[0]?.n);
      expect(await x.count('obs_revision')).toBe(0);

      // An ordinary payload of the same body, an hour later: rows older than 6 h before the previous loaded payload
      // are outside the window; the rest confirm what is stored (no new row, no change, no revision).
      await send(new Date(f.at.getTime() + 3_600_000), false);
      const later = await x.loader({ now: new Date(f.at.getTime() + 2 * 3_600_000) }).tick();
      expect(later).toEqual({ lines: 1, loaded: 1 });
      expect(x.alerts).toEqual([]);
      const second = (await batches(x))[1];
      expect(second).toMatchObject({ parse_status: 'ok', n_new: 0, n_changed: 0, n_skipped: 0 });
      const since = new Date(f.at.getTime() - 6 * 3_600_000);
      const { rows: inWindow } = await x.t.admin.query(`SELECT count(*)::int AS n FROM obs WHERE ts >= $1`, [since]);
      expect(second?.n_rows).toBe(inWindow[0]?.n);
      expect(second?.n_rows).toBeGreaterThan(1_000);
      expect(second?.n_rows).toBeLessThan((seed?.n_rows as number) / 10);
      expect(await x.count('obs_revision')).toBe(0);
      expect(await x.count('obs')).toBe(stored[0]?.n);
      // The confirmed points now belong to the newer fetch.
      const { rows: moved } = await x.t.admin.query(`SELECT count(*)::int AS n FROM obs WHERE batch_id = $1`, [
        second?.id,
      ]);
      expect(moved).toEqual([{ n: second?.n_rows }]);
      // The oldest confirmed point is 6 h before the seed's fetch time.
      const { rows: oldest } = await x.t.admin.query<{ ts: Date }>(
        `SELECT min(ts) AS ts FROM obs WHERE batch_id = $1`,
        [second?.id],
      );
      expect(oldest[0]?.ts.getTime()).toBeGreaterThanOrEqual(f.at.getTime() - 6 * 3_600_000);
    } finally {
      await x.close();
    }
  });
});

describe('LU-1 without a measured offset', { timeout: 60_000 }, () => {
  it('a day nobody measured takes 0: the rows sit at the labels themselves', async () => {
    const x = await harness();
    try {
      const f = recorded('lu-1-csv-day', 'LU-1');
      await writePayload(x.archive, {
        source: 'LU-1',
        spec: 'lu-1-csv',
        variant: '',
        at: f.at,
        body: f.body,
        url: f.url,
      });
      expect(await x.loader({ now: AFTER }).tick()).toEqual({ lines: 1, loaded: 1 });
      expect(x.alerts).toEqual([]);
      const diekirch = await rows(x, 'LU-1', 'Diekirch');
      expect(diekirch).toHaveLength(96);
      // 28.09.2026 15:45 Luxembourg time is 13:45Z; 29.09.2026 15:30 is 13:30Z.
      expect(diekirch[0]?.ts.toISOString()).toBe('2026-09-28T13:45:00.000Z');
      expect(diekirch.at(-1)?.ts.toISOString()).toBe('2026-09-29T13:30:00.000Z');
      expect(diekirch[0]?.value).toBeCloseTo(120.1, 4);
    } finally {
      await x.close();
    }
  });
});
