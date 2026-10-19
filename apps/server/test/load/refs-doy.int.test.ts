import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyReferences, type ResolvedRef } from '../../src/load/refs.ts';
import { openBatch, type Tx } from '../../src/load/store.ts';
import { type Harness, harness, KAUB_W } from './harness.ts';

// P14f: the loader's refScope closer leaves our day-of-year rows alone. A DE-1 payload states a series' full set of
// kinds (refScope) and closes the ranges of any kind it no longer states, but the DOY rows carry the series' own source
// id (DE-1) and no payload ever states them: without the guard in applyReferences' stored-rows query the next DE-1
// payload would close all 730 of them.

let h: Harness;
let kaub: number;
let n = 0;

beforeAll(async () => {
  h = await harness();
  kaub = await h.seriesId(KAUB_W);
  // Two day keys of a DOY set, as the climatology command stores them (open from 2026-10-01).
  await h.t.admin.query(
    `INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, percentile_convention, period,
                                  season_from_md, season_to_md, priority, basis_label, valid, seen_at)
     SELECT $1, 'DE-1', k.kind, k.v, 'cm', 'statistical', 'non_exceedance', '[2010-01-01,2020-01-01)', k.md, k.md, 0,
            'DOY P10-P90, 2010-2019, 31 d/yr', tstzrange('2026-10-01T00:00:00Z', NULL), '2026-10-01T00:00:00Z'
     FROM (VALUES ('P10_DOY', 101, 50.0), ('P90_DOY', 101, 300.0), ('P10_DOY', 1231, 60.0), ('P90_DOY', 1231, 310.0))
       AS k(kind, md, v)`,
    [kaub],
  );
}, 120_000);
afterAll(() => h.close());

const tx = <T>(fn: (tx: Tx) => Promise<T>) => h.load.db.transaction().execute(fn);
const batch = (at: string) =>
  tx(async (t) => {
    n += 1;
    const state = await openBatch(
      t,
      {
        source: 'DE-1',
        spec: 'p14f-test',
        key: `raw/DE-1/p14f-test/2026/10/03/${String(n).padStart(6, '0')}.zst`,
        sha256: null,
        fetchedAt: new Date(at),
        status: 200,
        bytes: 1,
        adapterVersion: 1,
      },
      'ok',
    );
    return state.id;
  });
const mnw = (): ResolvedRef => ({
  series: KAUB_W,
  kind: 'MNW',
  value: 65,
  unit: 'cm',
  semantics: 'statistical',
  convention: null,
  period: ['2010-11-01', '2020-10-31'],
  season_from_md: 101,
  season_to_md: 1231,
  priority: 0,
  basis_label: 'Mittel der Niedrigwasserstände',
  valid_from: null,
  id: kaub,
  counted: true,
});
const apply = async (at: string, rows: ResolvedRef[]) => {
  const b = await batch(at);
  return tx((t) => applyReferences(t, 'DE-1', rows, new Set([kaub]), b, new Date(at)));
};
const open = async (kind: string) =>
  (
    await h.t.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reference_value WHERE series_id = $1 AND kind = $2 AND upper_inf(valid)`,
      [kaub, kind],
    )
  ).rows[0]?.n;

describe('applyReferences leaves the day-of-year rows alone', { timeout: 120_000 }, () => {
  it('a refScope payload that never states them keeps them open, and still closes its own kind', async () => {
    const first = await apply('2026-10-03T04:20:00Z', [mnw()]);
    expect(first.changes).toEqual({ new: 1 });
    expect(await open('P10_DOY')).toBe(2);
    expect(await open('P90_DOY')).toBe(2);
    // The payload no longer states MNW: its own kind is closed (removed), the day-of-year rows are not.
    const gone = await apply('2026-10-04T04:20:00Z', []);
    expect(gone.changes).toEqual({ removed: 1 });
    expect(await open('MNW')).toBe(0);
    expect(await open('P10_DOY')).toBe(2);
    expect(await open('P90_DOY')).toBe(2);
    // Not touched at all: not even their seen_at moved.
    const rows = await h.t.admin.query<{ seen: Date | null }>(
      `SELECT seen_at AS seen FROM reference_value WHERE series_id = $1 AND kind = 'P10_DOY'`,
      [kaub],
    );
    expect(rows.rows.every((r) => r.seen?.toISOString() === '2026-10-01T00:00:00.000Z')).toBe(true);
  });
});
