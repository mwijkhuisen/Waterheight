import { QC } from '@rws/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VIEWS } from '../../src/db/audience.ts';
import { detectLabelOffsets, labelOffsetsOf, offsetKey } from '../../src/load/label-offset.ts';
import { checkTwins } from '../../src/load/twins.ts';
import { type Harness, harness } from './harness.ts';

// The P5b twin pairs and the LU-1 label offset on seeded rows (issue #20): the lag of a pair is found and signed,
// a flat river invents none, rows that FR-3 filled into FR-1 are left out (KG-121), a pair is shown to a family
// only when both of its series are, a tolerance is a tolerance, and the nightly detector measures the offset of
// a UTC day once, alerts when it is not the one the loads applied, and says so when the day decides nothing.

let h: Harness;

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = new Date('2026-10-02T12:10:00Z');
// checkTwins: the window ends at the hour (12:00Z), reaches 24 hours back, and leaves the newest 30 minutes out.
const WINDOW_FROM = Date.parse('2026-10-01T12:00:00Z');
const WINDOW_TO = Date.parse('2026-10-02T11:30:00Z');
/** The points of the window on a 15-minute grid: (from, to]. */
const WINDOW_POINTS = (WINDOW_TO - WINDOW_FROM) / (15 * MIN);

const PERL_LU = ['LU-1', 'Perl'] as const;
const PERL_DE = ['DE-1', 'c263ea53-ca4d-41f5-b3f5-6178fec302aa/W'] as const;
const CHOOZ = 'B720000001/H';
const UCKANGE = 'A850061001/Q';
const BASEL_CH = ['CH-1', '2289/W'] as const;
const BASEL_DE = ['DE-1', '94f6eff1-4f3f-4850-82e0-a086198e9ffd/W'] as const;

type Key = readonly [source: string, key: string];
const ids = new Map<string, number>();

async function sid(source: string, key: string): Promise<number> {
  const name = `${source} ${key}`;
  let id = ids.get(name);
  if (id === undefined) {
    const { rows } = await h.t.admin.query<{ id: number }>(
      'SELECT id FROM series WHERE source_id = $1 AND provider_key = $2',
      [source, key],
    );
    if (rows[0] === undefined) throw new Error(`no series ${name}`);
    id = rows[0].id;
    ids.set(name, id);
  }
  return id;
}

/** A deterministic signal that no shifted copy of itself matches: a slow wave plus a period-13 jitter. */
const signal = (k: number) => Math.round((300 + 40 * Math.sin(k / 7) + ((k * 7919) % 13)) * 10) / 10;
const iso = (ms: number) => new Date(ms).toISOString();
/** Grid instants from `from` to `to`, both included. */
const grid = (from: number, to: number, stepMin = 15) =>
  Array.from({ length: Math.floor((to - from) / (stepMin * MIN)) + 1 }, (_, i) => from + i * stepMin * MIN);

/** Replaces the rows of a series: value(ts) at each instant. */
async function put(
  key: Key,
  instants: readonly number[],
  value: (ts: number) => number,
  qc: (ts: number) => number = () => QC.RAW,
) {
  const id = await sid(key[0], key[1]);
  await h.t.admin.query('DELETE FROM obs WHERE series_id = $1', [id]);
  if (instants.length === 0) return;
  await h.t.admin.query(`SELECT ensure_partitions($1::timestamptz, $2::timestamptz)`, [
    iso(Math.min(...instants)),
    iso(Math.max(...instants)),
  ]);
  await h.t.admin.query(
    `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     SELECT $1, u.ts, u.value, u.qc, 1 FROM unnest($2::timestamptz[], $3::real[], $4::int2[]) AS u(ts, value, qc)`,
    [id, instants.map(iso), instants.map(value), instants.map(qc)],
  );
}

/** The window of checkTwins with a margin of the largest lag (60 minutes) on each side. */
const around = grid(WINDOW_FROM - 60 * MIN, WINDOW_TO + 60 * MIN);
const step = (ts: number) => Math.round(ts / (15 * MIN));

const check = async (twin: string) =>
  (
    await h.t.admin.query<{
      window_end: Date;
      n_aligned: number;
      median_delta: number | null;
      max_delta: number | null;
      lag_min: number | null;
      ok: boolean;
    }>(
      'SELECT window_end, n_aligned, median_delta, max_delta, lag_min, ok FROM twin_check WHERE twin_id = $1 ORDER BY window_end',
      [twin],
    )
  ).rows;

beforeAll(async () => {
  h = await harness();
});

afterAll(async () => {
  await h.close();
});

describe('the registered pairs', { timeout: 60_000 }, () => {
  it('are the seven of registry/twins.yaml, each between two series that exist', async () => {
    const { rows } = await h.t.admin.query<{ id: string }>('SELECT id FROM twin ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual([
      'basel-ch1-de1-h',
      'chooz-fr3-fr1-h',
      'eijsden-grens-taw-nap',
      'grevenmacher-lu1-de1-h',
      'perl-lu1-de1-h',
      'stadtbredimus-lu1-de1-h',
      'uckange-fr3-fr1-q',
    ]);
  });
});

describe('Perl: LU-1 against DE-1 (lag, sign, flat river)', { timeout: 60_000 }, () => {
  const TWIN = 'perl-lu1-de1-h';

  it('equal values on the same instants: ok, lag 0, every point of the window aligned', async () => {
    await put(PERL_DE, around, (ts) => signal(step(ts)));
    await put(PERL_LU, around, (ts) => signal(step(ts)));
    expect(await checkTwins(h.load.db, NOW)).toEqual([]);
    expect(await check(TWIN)).toEqual([
      {
        window_end: new Date('2026-10-02T12:00:00Z'),
        n_aligned: WINDOW_POINTS,
        median_delta: 0,
        max_delta: 0,
        lag_min: 0,
        ok: true,
      },
    ]);
    expect(WINDOW_POINTS).toBe(94);
  });

  it('LU-1 stating each value 15 minutes late has lag −15 (minutes added to a’s instants to meet b’s) and breaches once', async () => {
    // a (LU-1) at t carries what b (DE-1) had at t − 15 minutes: a's instants + (−15) meet b's.
    await put(PERL_LU, around, (ts) => signal(step(ts) - 1));
    expect(await checkTwins(h.load.db, NOW)).toEqual([TWIN]);
    const [row] = await check(TWIN);
    expect(row).toMatchObject({ n_aligned: WINDOW_POINTS, lag_min: -15, ok: false });
    expect(Math.abs(row?.max_delta ?? 0)).toBeGreaterThan(0.05);
    // The same hour again: already failing, not reported again.
    expect(await checkTwins(h.load.db, NOW)).toEqual([]);
  });

  it('and 15 minutes early has lag +15', async () => {
    await put(PERL_LU, around, (ts) => signal(step(ts) + 1));
    await checkTwins(h.load.db, NOW);
    expect((await check(TWIN))[0]).toMatchObject({ lag_min: 15, ok: false });
  });

  it('a flat river agrees at every shift: no lag is invented, and the pair is ok', async () => {
    await put(PERL_DE, around, () => 300);
    await put(PERL_LU, around, () => 300);
    await checkTwins(h.load.db, NOW);
    expect((await check(TWIN))[0]).toMatchObject({ n_aligned: WINDOW_POINTS, lag_min: 0, ok: true });
  });
});

describe('Chooz and Uckange: FR-3 against FR-1', { timeout: 60_000 }, () => {
  const TWIN = 'chooz-fr3-fr1-h';
  const FILL = QC.RAW | QC.BACKFILLED;

  it('KG-121: FR-1 rows that FR-3 filled are left out, so FR-3 is never compared with itself', async () => {
    await put(['FR-3', CHOOZ], around, (ts) => signal(step(ts)));
    // Every FR-1 row is a fill row: nothing to compare with, and a pair never checked gets no row.
    await put(
      ['FR-1', CHOOZ],
      around,
      (ts) => signal(step(ts)),
      () => FILL,
    );
    expect(await checkTwins(h.load.db, NOW)).toEqual([]);
    expect(await check(TWIN)).toEqual([]);

    // The first half of the window is FR-1's own, the rest filled: only the own points align.
    const middle = WINDOW_FROM + 12 * 60 * MIN;
    await put(
      ['FR-1', CHOOZ],
      around,
      (ts) => signal(step(ts)),
      (ts) => (ts <= middle ? QC.RAW : FILL),
    );
    expect(await checkTwins(h.load.db, NOW)).toEqual([]);
    const own = (middle - WINDOW_FROM) / (15 * MIN);
    expect((await check(TWIN))[0]).toMatchObject({ n_aligned: own, lag_min: 0, ok: true });

    // Nothing but fill rows again: a pair that was checked before fails with 0 aligned (no data is never ok).
    await put(
      ['FR-1', CHOOZ],
      around,
      (ts) => signal(step(ts)),
      () => FILL,
    );
    expect(await checkTwins(h.load.db, NOW)).toEqual([TWIN]);
    expect((await check(TWIN))[0]).toMatchObject({ n_aligned: 0, median_delta: null, lag_min: null, ok: false });

    // A fill row on the FR-3 side is left out too.
    await put(['FR-1', CHOOZ], around, (ts) => signal(step(ts)));
    await put(
      ['FR-3', CHOOZ],
      around,
      (ts) => signal(step(ts)),
      () => FILL,
    );
    await checkTwins(h.load.db, NOW);
    expect((await check(TWIN))[0]).toMatchObject({ n_aligned: 0, ok: false });
  });

  it('Uckange: a difference of 0.0005 m³/s is inside the tolerance of 0.001, 0.01 is not', async () => {
    const TWIN_Q = 'uckange-fr3-fr1-q';
    const q = (ts: number) => 14.5 + (signal(step(ts)) - 300) / 100;
    await put(['FR-1', UCKANGE], around, q);
    await put(['FR-3', UCKANGE], around, (ts) => q(ts) + 0.0005);
    expect(await checkTwins(h.load.db, NOW)).toEqual([]);
    expect((await check(TWIN_Q))[0]).toMatchObject({ n_aligned: WINDOW_POINTS, lag_min: 0, ok: true });
    expect((await check(TWIN_Q))[0]?.max_delta).toBeCloseTo(0.0005, 5);

    await put(['FR-3', UCKANGE], around, (ts) => q(ts) + 0.01);
    expect(await checkTwins(h.load.db, NOW)).toEqual([TWIN_Q]);
    expect((await check(TWIN_Q))[0]).toMatchObject({ n_aligned: WINDOW_POINTS, lag_min: 0, ok: false });
    expect((await check(TWIN_Q))[0]?.max_delta).toBeCloseTo(0.01, 5);
  });
});

describe('Basel: CH-1 in m LN02 against the DE-1 mirror (stage + 240.00 m)', { timeout: 60_000 }, () => {
  const TWIN = 'basel-ch1-de1-h';
  const readers = new Map<string, Awaited<ReturnType<Harness['t']['connectAs']>>>();
  const seen = async (role: 'rws_api' | 'rws_owner_api', view: string) => {
    let client = readers.get(role);
    if (client === undefined) {
      client = await h.t.connectAs(role);
      readers.set(role, client);
    }
    return (await client.query(`SELECT twin_id FROM ${view} WHERE twin_id = $1`, [TWIN])).rows.length;
  };

  it('a − b = 24,000 cm within 1 cm is ok; the check shows although b is a mirror, until either side is off', async () => {
    const err = [-0.4, 0, 0.4];
    await put(BASEL_DE, around, (ts) => signal(step(ts)));
    await put(BASEL_CH, around, (ts) => signal(step(ts)) + 24000 + (err[step(ts) % 3] as number));
    expect(await checkTwins(h.load.db, NOW)).toEqual([]);
    expect((await check(TWIN))[0]).toMatchObject({ n_aligned: WINDOW_POINTS, lag_min: 0, ok: true });
    expect((await check(TWIN))[0]?.median_delta).toBeCloseTo(24000, 0);

    // b is a mirror (role), not an audience: both families show the check.
    const role = await h.t.admin.query('SELECT role FROM series WHERE id = $1', [await sid(...BASEL_DE)]);
    expect(role.rows).toEqual([{ role: 'mirror' }]);
    expect(await seen('rws_api', VIEWS.public.twinCheck)).toBe(1);
    expect(await seen('rws_owner_api', VIEWS.owner.twinCheck)).toBe(1);

    for (const key of [BASEL_CH, BASEL_DE]) {
      const id = await sid(key[0], key[1]);
      await h.t.admin.query(`UPDATE series SET audience = 'off' WHERE id = $1`, [id]);
      expect(await seen('rws_api', VIEWS.public.twinCheck), `${key[1]} off`).toBe(0);
      expect(await seen('rws_owner_api', VIEWS.owner.twinCheck), `${key[1]} off`).toBe(0);
      await h.t.admin.query('UPDATE series SET audience = NULL WHERE id = $1', [id]);
      expect(await seen('rws_api', VIEWS.public.twinCheck), `${key[1]} back`).toBe(1);
    }
  });

  it('a Basel level 2 cm off the offset breaches', async () => {
    await put(BASEL_CH, around, (ts) => signal(step(ts)) + 24002);
    expect(await checkTwins(h.load.db, NOW)).toEqual([TWIN]);
    // (Its lag_min is only a diagnosis: on a falling river a constant bias of 2 cm also "agrees" at a shift.)
    expect((await check(TWIN))[0]).toMatchObject({ n_aligned: WINDOW_POINTS, ok: false });
  });
});

describe('the LU-1 label offset detector', { timeout: 60_000 }, () => {
  const alerts: { code: string; fields: Record<string, string | number> }[] = [];
  const alert = (code: string, fields: Record<string, string | number>) => alerts.push({ code, fields });
  const D = (n: number) => iso(Date.UTC(2026, 9, 2 + n)).slice(0, 10);
  /** The detector at 03:00Z of the day after day `n` (day 0 is 2026-10-02). */
  const detect = (n: number) => detectLabelOffsets(h.load.db, new Date(Date.UTC(2026, 9, 3 + n, 3)), alert);
  const state = async () =>
    (await h.t.admin.query<{ value: unknown }>('SELECT value FROM app_meta WHERE key = $1', [offsetKey('LU-1')]))
      .rows[0]?.value;
  const detail = async () =>
    (
      await h.t.admin.query<{ d: unknown }>(
        `SELECT detail->'label_offset' AS d FROM source_health WHERE source_id = 'LU-1'`,
      )
    ).rows[0]?.d;

  /** DE-1 Perl over day `n` and 30 minutes either side; LU-1 Perl over the day itself, `late` minutes after DE-1's. */
  async function day(n: number, lu: (ts: number) => number, de: (ts: number) => number) {
    const from = Date.UTC(2026, 9, 2 + n);
    await put(PERL_DE, grid(from - 30 * MIN, from + DAY + 15 * MIN), de);
    await put(PERL_LU, grid(from, from + DAY - 15 * MIN), lu);
  }

  beforeAll(async () => {
    await h.t.admin.query(`INSERT INTO source_health (source_id, status) VALUES ('LU-1', 'ok') ON CONFLICT DO NOTHING`);
  });

  it('rows stored where DE-1 has them: the offset the loads applied (the default 0) is confirmed, with no alert', async () => {
    await day(
      0,
      (ts) => signal(step(ts)),
      (ts) => signal(step(ts)),
    );
    await detect(0);
    expect(alerts).toEqual([]);
    expect(await state()).toEqual({ days: { [D(0)]: { minutes: 0, n_aligned: 96, share: 1 } } });
    expect(await detail()).toEqual({ day: D(0), minutes: 0, n_aligned: 96, share: 1 });
  });

  it('rows stored 15 minutes after DE-1’s: 15 minutes, and label_offset_changed from 0 to 15', async () => {
    // Stored LU-1 points sit 15 minutes after the instants DE-1 states the same value at: the loads applied
    // 0 minutes (carried forward from the day before), the true offset is 15.
    await day(
      1,
      (ts) => signal(step(ts) - 1),
      (ts) => signal(step(ts)),
    );
    await detect(1);
    expect(alerts).toEqual([{ code: 'label_offset_changed', fields: { source: 'LU-1', day: D(1), from: 0, to: 15 } }]);
    expect(await state()).toEqual({
      days: { [D(0)]: { minutes: 0, n_aligned: 96, share: 1 }, [D(1)]: { minutes: 15, n_aligned: 96, share: 1 } },
    });
    expect(await detail()).toEqual({ day: D(1), minutes: 15, n_aligned: 96, share: 1 });
  });

  it('a flat day decides nothing: label_offset_unknown, and nothing is stored', async () => {
    alerts.length = 0;
    const before = await state();
    await day(
      2,
      () => 300,
      () => 300,
    );
    await detect(2);
    expect(alerts).toEqual([{ code: 'label_offset_unknown', fields: { source: 'LU-1', day: D(2) } }]);
    expect(await state()).toEqual(before);
  });

  it('a day that is measured is never measured again', async () => {
    alerts.length = 0;
    const before = { state: await state(), detail: await detail() };
    // Different rows on a measured day change nothing.
    await day(
      1,
      (ts) => signal(step(ts) + 3),
      (ts) => signal(step(ts)),
    );
    await detect(1);
    await detect(0);
    expect(alerts).toEqual([]);
    expect({ state: await state(), detail: await detail() }).toEqual(before);
  });

  it('without the DE-1 rows of the day: label_offset_unknown', async () => {
    alerts.length = 0;
    await day(
      3,
      (ts) => signal(step(ts)),
      (ts) => signal(step(ts)),
    );
    await h.t.admin.query('DELETE FROM obs WHERE series_id = $1', [await sid(...PERL_DE)]);
    await detect(3);
    expect(alerts).toEqual([{ code: 'label_offset_unknown', fields: { source: 'LU-1', day: D(3) } }]);
  });

  it('the label offsets reach the loader as minutes per day', async () => {
    expect(await labelOffsetsOf(h.load.db, 'LU-1')).toEqual({ days: { [D(0)]: 0, [D(1)]: 15 } });
  });
});
