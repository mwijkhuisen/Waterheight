import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FORECAST_AT } from '../../src/db/audience.ts';
import { createTestDb, type TestDb } from './testdb.ts';

// A§8 Q2, "the latest forecast run as of T" (P8a, C7): per (series, source) the latest run known at `asof`, and only
// if that run reaches `t`; never an older run that does, never another source's, the value held (not interpolated)
// at the greatest valid time at or before `t`. Every query runs as a real reader login through FORECAST_AT.
// Instants are hours from D0; each test owns its series, and the function's rows are filtered to it.

const D0 = Date.UTC(2026, 10, 10); // 2026-11-10T00:00:00Z
const at = (hours: number) => new Date(D0 + hours * 3_600_000).toISOString();

type Point = { value?: number | null; p30?: number; p70?: number; flags?: number };
type RunSpec = {
  issued: number | null;
  fetched: number;
  /** [hours from D0, value or a point with more columns] */
  points: [number, number | Point][];
  kind?: 'deterministic' | 'quantiles';
};

let t: TestDb;
let api: pg.Client;
let owner: pg.Client;
let nSeries = 0;
let nRun = 0;
/** run id → label, so that an answer reads as `NL-1:B` */
const label = new Map<string, string>();

beforeAll(async () => {
  t = await createTestDb();
  await t.admin.query(`
    INSERT INTO provider (id, name, country) VALUES ('rws', 'RWS', 'NL'), ('bfg', 'BfG', 'DE');
    INSERT INTO source (id, provider_id, name, audience, private_basis, lic_display, lic_api, lic_bulk_export,
                        lic_history_export, history_window, capture_enabled) VALUES
      ('NL-1', 'rws', 'public', 'public', NULL, true, true, true, true, '0', true),
      ('DE-1', 'rws', 'public', 'public', NULL, true, true, true, true, '0', true),
      ('DE-2', 'bfg', 'owner', 'owner',
       '{"clause": "c", "url": "https://example.org/terms", "retrieved": "2026-09-24"}'::jsonb,
       true, true, false, true, '0', true);
    SELECT ensure_partitions(timestamptz '2026-11-01', timestamptz '2026-12-31');`);
  api = await t.connectAs('rws_api');
  owner = await t.connectAs('rws_owner_api');
});

afterAll(async () => {
  await t.drop();
});

/** A series of its own on a station of its own. */
async function series(opts: { role?: string; audience?: string } = {}): Promise<number> {
  nSeries += 1;
  await t.admin.query("INSERT INTO station (id, name, country, tier) VALUES ($1, 'fixture', 'NL', 1)", [
    `nl.fc.${nSeries}`,
  ]);
  const { rows } = await t.admin.query<{ id: number }>(
    `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                         native_step, expected_step, staleness_limit, role, audience)
     VALUES ($1, 'DE-1', 'H', 'stage', $2, 'cm', 1, 'LOCAL', '15 min', '15 min', '45 min', $3, $4::audience)
     RETURNING id`,
    [`nl.fc.${nSeries}`, `k${nSeries}`, opts.role ?? 'primary', opts.audience ?? null],
  );
  return (rows[0] as { id: number }).id;
}

async function run(seriesId: number, source: string, name: string, spec: RunSpec): Promise<void> {
  nRun += 1;
  const hours = spec.points.map(([h]) => h);
  const { rows } = await t.admin.query<{ id: string }>(
    `INSERT INTO forecast_run (series_id, source_id, issued_at, issued_inferred, first_valid, last_valid, fetched_at,
                               content_hash, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, sha256(convert_to($8, 'UTF8')), $9)
     RETURNING id`,
    [
      seriesId,
      source,
      spec.issued === null ? null : at(spec.issued),
      spec.issued === null,
      at(Math.min(...hours)),
      at(Math.max(...hours)),
      at(spec.fetched),
      `run ${nRun}`,
      spec.kind ?? 'deterministic',
    ],
  );
  const id = (rows[0] as { id: string }).id;
  label.set(id, `${source}:${name}`);
  for (const [h, p] of spec.points) {
    const point: Point = typeof p === 'number' ? { value: p } : p;
    await t.admin.query(
      'INSERT INTO forecast_value (run_id, valid_ts, value, p30, p70, flags) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, at(h), point.value ?? null, point.p30 ?? null, point.p70 ?? null, point.flags ?? 0],
    );
  }
}

type Row = Record<string, unknown> & { run_id: string; series_id: number; source_id: string; value: number | null };
async function q2(client: pg.Client, fn: string, seriesId: number, asof: number, tt: number): Promise<Row[]> {
  const { rows } = await client.query<Row>(
    `SELECT * FROM ${fn}($1::timestamptz, $2::timestamptz) WHERE series_id = $3 ORDER BY source_id`,
    [at(asof), at(tt), seriesId],
  );
  return rows;
}
const pub = (s: number, asof: number, tt: number) => q2(api, FORECAST_AT.public, s, asof, tt);
const own = (s: number, asof: number, tt: number) => q2(owner, FORECAST_AT.owner, s, asof, tt);
/** `NL-1:B=110`: which run answered, and its held value */
const seen = (rows: Row[]) => rows.map((r) => `${label.get(r.run_id)}=${r.value}`);

describe('A§8 Q2: the latest run as of T', { timeout: 300_000 }, () => {
  it('has the columns the contract lists, in order', async () => {
    const s = await series();
    await run(s, 'NL-1', 'A', { issued: 0, fetched: 0, points: [[0, 1]] });
    const { fields } = await api.query(`SELECT * FROM ${FORECAST_AT.public}($1::timestamptz, $2::timestamptz)`, [
      at(1),
      at(1),
    ]);
    expect(fields.map((f) => f.name)).toEqual([
      'run_id',
      'series_id',
      'source_id',
      'issued_at',
      'issued_inferred',
      'fetched_at',
      'first_valid',
      'last_valid',
      'kind',
      'step',
      'provider_segment_end',
      'valid_ts',
      'value',
      'p05',
      'p10',
      'p25',
      'p30',
      'p50',
      'p70',
      'p75',
      'p90',
      'p95',
      'vmin',
      'vmax',
      'flags',
    ]);
  });

  it('takes the latest run first and only then asks whether it covers t: no fallback to an older run that reaches further', async () => {
    const s = await series();
    // A reaches 96 h; B, issued later, only 36 h.
    await run(s, 'NL-1', 'A', {
      issued: 0,
      fetched: 0.1,
      points: [
        [0, 10],
        [24, 20],
        [48, 30],
        [72, 40],
        [96, 50],
      ],
    });
    await run(s, 'NL-1', 'B', {
      issued: 12,
      fetched: 12.1,
      points: [
        [12, 100],
        [24, 110],
        [36, 120],
      ],
    });
    expect(seen(await pub(s, 13, 30))).toEqual(['NL-1:B=110']);
    expect(seen(await pub(s, 13, 36))).toEqual(['NL-1:B=120']); // last_valid itself is covered
    expect(seen(await pub(s, 13, 36.001))).toEqual([]); // 3.6 s past it: no forecast, never A's held value
    expect(seen(await pub(s, 13, 60))).toEqual([]);
    expect(seen(await pub(s, 13, 96))).toEqual([]);
    // Before B was issued, A is the latest run known and does cover.
    expect(seen(await pub(s, 11, 60))).toEqual(['NL-1:A=30']);
    // B is issued at 12 h but fetched at 12.1 h: unknown at 12 h, and the latest (and short) run from 12.1 h on.
    expect(seen(await pub(s, 12, 60))).toEqual(['NL-1:A=30']);
    expect(seen(await pub(s, 12.1, 60))).toEqual([]);
  });

  it('knows a run only from its fetch: fetched_at at or before asof, and an issue time in the future is not known', async () => {
    const s = await series();
    await run(s, 'NL-1', 'D', {
      issued: 2,
      fetched: 2.5,
      points: [
        [2, 1],
        [40, 2],
      ],
    });
    // C was issued at 6 h and loaded at 18 h (a replay, a late fetch): it did not exist for a reader at 12 h.
    await run(s, 'NL-1', 'C', {
      issued: 6,
      fetched: 18,
      points: [
        [6, 500],
        [30, 600],
      ],
    });
    expect(seen(await pub(s, 12, 12))).toEqual(['NL-1:D=1']);
    expect(seen(await pub(s, 17.99, 20))).toEqual(['NL-1:D=1']);
    expect(seen(await pub(s, 18, 20))).toEqual(['NL-1:C=500']);
    expect(seen(await pub(s, 19, 35))).toEqual([]); // C is the latest known and ends at 30 h

    // The provider's issue time ahead of the fetch (clock skew): not known before it either.
    const s2 = await series();
    await run(s2, 'NL-1', 'E0', {
      issued: 1,
      fetched: 1,
      points: [
        [1, 7],
        [60, 8],
      ],
    });
    await run(s2, 'NL-1', 'E', {
      issued: 30,
      fetched: 20,
      points: [
        [30, 70],
        [60, 80],
      ],
    });
    expect(seen(await pub(s2, 25, 40))).toEqual(['NL-1:E0=7']);
    expect(seen(await pub(s2, 30, 40))).toEqual(['NL-1:E=70']);
  });

  it('orders a run without a stated issue time by its fetch time', async () => {
    const s = await series();
    await run(s, 'NL-1', 'P', {
      issued: 0,
      fetched: 0,
      points: [
        [0, 1],
        [96, 2],
      ],
    });
    await run(s, 'NL-1', 'Q', {
      issued: null,
      fetched: 40,
      points: [
        [39, 10],
        [96, 20],
      ],
    });
    expect(seen(await pub(s, 39.99, 50))).toEqual(['NL-1:P=1']);
    const [q] = await pub(s, 40, 50);
    expect(seen(q ? [q] : [])).toEqual(['NL-1:Q=10']);
    expect(q).toMatchObject({ issued_at: null, issued_inferred: true });
  });

  it('two sources on one series are two rows and never mixed', async () => {
    const s = await series();
    await run(s, 'NL-1', 'N1', {
      issued: 0,
      fetched: 0,
      points: [
        [0, 1],
        [48, 1],
      ],
    });
    await run(s, 'NL-1', 'N2', {
      issued: 6,
      fetched: 6,
      points: [
        [6, 2],
        [12, 2],
      ],
    });
    await run(s, 'DE-1', 'D1', {
      issued: 3,
      fetched: 3,
      points: [
        [3, 3],
        [48, 3],
      ],
    });
    expect(seen(await pub(s, 7, 10))).toEqual(['DE-1:D1=3', 'NL-1:N2=2']);
    // NL-1's latest run ends at 12 h: NL-1 has no forecast at 20 h, however far N1 or D1 reach.
    expect(seen(await pub(s, 7, 20))).toEqual(['DE-1:D1=3']);
    expect(seen(await pub(s, 7, 49))).toEqual([]);
    // An owner source's run on the same series is an owner row only.
    await run(s, 'DE-2', 'O1', {
      issued: 4,
      fetched: 4,
      points: [
        [4, 9],
        [48, 9],
      ],
    });
    expect(seen(await pub(s, 7, 20))).toEqual(['DE-1:D1=3']);
    expect(seen(await own(s, 7, 20))).toEqual(['DE-1:D1=3', 'DE-2:O1=9']);
    expect(seen(await own(s, 7, 10))).toEqual(['DE-1:D1=3', 'DE-2:O1=9', 'NL-1:N2=2']);
  });

  it('holds the value of the last point at or before t, never interpolates, and keeps the columns of one point together', async () => {
    const s = await series();
    await run(s, 'NL-1', 'H', {
      issued: 0,
      fetched: 0,
      kind: 'quantiles',
      points: [
        [0, { value: 10, p30: 8, p70: 12, flags: 0 }],
        [2, { value: 20, p30: 18, p70: 22, flags: 256 }],
        [4, { value: 30, p30: 28, p70: 32, flags: 16 }],
      ],
    });
    const held = async (tt: number) => {
      const [row] = await pub(s, 0, tt);
      return row === undefined ? null : [Number(row.value), Number(row.p30), Number(row.p70), Number(row.flags)];
    };
    expect(await held(0)).toEqual([10, 8, 12, 0]);
    expect(await held(1)).toEqual([10, 8, 12, 0]); // not 15
    expect(await held(1.9999)).toEqual([10, 8, 12, 0]);
    expect(await held(2)).toEqual([20, 18, 22, 256]);
    expect(await held(3.5)).toEqual([20, 18, 22, 256]); // not 25
    expect(await held(4)).toEqual([30, 28, 32, 16]);
    expect(await held(4.0001)).toBeNull();
    const [row] = await pub(s, 0, 3);
    expect(row).toMatchObject({ valid_ts: new Date(at(2)), kind: 'quantiles', p05: null, p50: null, vmax: null });
  });

  it('gives nothing for a t before the first point, and the first point at it', async () => {
    const s = await series();
    // Issued at 0 h, first stated step at 10 h.
    await run(s, 'NL-1', 'Q', {
      issued: 0,
      fetched: 0,
      points: [
        [10, 5],
        [20, 6],
      ],
    });
    expect(seen(await pub(s, 1, 5))).toEqual([]);
    expect(seen(await pub(s, 1, 9.999))).toEqual([]);
    expect(seen(await pub(s, 1, 10))).toEqual(['NL-1:Q=5']);
    expect(seen(await pub(s, 1, 15))).toEqual(['NL-1:Q=5']);
  });

  it('gives nothing when t is before asof, and the run when they are equal', async () => {
    const s = await series();
    await run(s, 'NL-1', 'R', {
      issued: 0,
      fetched: 0,
      points: [
        [0, 1],
        [48, 2],
      ],
    });
    expect(seen(await pub(s, 12, 11))).toEqual([]);
    expect(seen(await pub(s, 12, 11.999))).toEqual([]);
    expect(seen(await pub(s, 12, 12))).toEqual(['NL-1:R=1']);
    expect(seen(await own(s, 12, 11))).toEqual([]);
  });

  it('breaks an issue-time tie by fetch time, then by run id', async () => {
    const s = await series();
    await run(s, 'NL-1', 'T1', {
      issued: 5,
      fetched: 6,
      points: [
        [5, 1],
        [30, 1],
      ],
    });
    await run(s, 'NL-1', 'T2', {
      issued: 5,
      fetched: 7,
      points: [
        [5, 2],
        [30, 2],
      ],
    });
    expect(seen(await pub(s, 6.5, 10))).toEqual(['NL-1:T1=1']); // T2 is not fetched yet
    expect(seen(await pub(s, 8, 10))).toEqual(['NL-1:T2=2']); // the later fetch
    // Same issue time and same fetch time: the greater id (the later insert) wins.
    await run(s, 'NL-1', 'T3', {
      issued: 5,
      fetched: 7,
      points: [
        [5, 3],
        [31, 3],
      ],
    });
    expect(seen(await pub(s, 8, 10))).toEqual(['NL-1:T3=3']);
    // An earlier issue time never wins by a later fetch.
    await run(s, 'NL-1', 'T0', {
      issued: 4,
      fetched: 9,
      points: [
        [4, 0],
        [30, 0],
      ],
    });
    expect(seen(await pub(s, 10, 10))).toEqual(['NL-1:T3=3']);
  });

  it('shows a series only when it is a visible primary series of the family, and a run only when its own source is visible', async () => {
    const mirror = await series({ role: 'mirror' });
    const off = await series({ audience: 'off' });
    const ownerOnly = await series({ audience: 'owner' });
    const visible = await series();
    for (const s of [mirror, off, ownerOnly, visible])
      await run(s, 'NL-1', 'V', {
        issued: 0,
        fetched: 0,
        points: [
          [0, 1],
          [48, 1],
        ],
      });
    // An owner source's run on a public series, and a public source's run on an owner series.
    await run(visible, 'DE-2', 'W', {
      issued: 1,
      fetched: 1,
      points: [
        [1, 2],
        [48, 2],
      ],
    });
    for (const [s, p, o] of [
      [mirror, [], []],
      [off, [], []],
      [ownerOnly, [], ['NL-1:V=1']],
      [visible, ['NL-1:V=1'], ['DE-2:W=2', 'NL-1:V=1']],
    ] as const) {
      expect(seen(await pub(s, 12, 12)), `public ${s}`).toEqual(p);
      expect(seen(await own(s, 12, 12)), `owner ${s}`).toEqual(o);
    }
  });
});
