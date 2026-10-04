import type { Snapshot, StateBasis } from '@rws/contracts';
import { SnapshotFile, toSnapshot } from '@rws/contracts';
import { describe, expect, it } from 'vitest';
import { columns } from '../../src/publish/render/snapshot.ts';
import { seriesHash } from '../../src/publish/render/stations.ts';

const A: StateBasis = { source: 'NL-1', kind: 'statistical', measure: 'stage', ref: 'MNW/MHW', label: 'a' };
const B: StateBasis = { ...A, source: 'DE-1', label: 'b' };
const T = '2026-10-04T12:00:00.000Z';
const value = (series: number, over: Partial<Snapshot['values'][number]> = {}): Snapshot['values'][number] => ({
  series,
  ts: '2026-10-04T11:58:00.000Z',
  value: 100 + series,
  qc: 0,
  ageSeconds: 120,
  state: 'normal',
  basis: { ...A },
  section: false,
  ...over,
});

describe('render columns', () => {
  const values = [
    value(2),
    value(5, { basis: { ...B }, area: { state: 'high', basis: { ...A } }, nap: { m: 1.5, pm: 0.1 } }),
    value(9, { state: 'no_ref', basis: null, zero: { m: 2, datum: 'IGN69' } }),
  ];
  const cols = columns(T, values);

  it('deduplicates bases and indexes them, null exactly for no_ref', () => {
    expect(cols.bases).toEqual([A, B]);
    expect(cols.basis).toEqual([0, 1, null]);
    expect(cols.area).toEqual([null, { state: 'high', basis: 0 }, null]);
  });
  it('keeps the order and fills the columns', () => {
    expect(cols.series).toEqual([2, 5, 9]);
    expect(cols.ageSeconds).toEqual([120, 120, 120]);
    expect(cols.nap).toEqual([null, { m: 1.5, pm: 0.1 }, null]);
    expect(cols.zero).toEqual([null, null, { m: 2, datum: 'IGN69' }]);
  });
  it('round-trips through the contract and toSnapshot', () => {
    const file = SnapshotFile.parse({ schemaVersion: 1, ...cols, attribution: [] });
    expect(toSnapshot(file)).toEqual({ t: T, values });
  });
  it('an empty snapshot is an empty file', () => {
    expect(SnapshotFile.parse({ schemaVersion: 1, ...columns(T, []), attribution: [] }).series).toEqual([]);
  });
});

describe('seriesHash', () => {
  it('is 16 hex digits of the sha256 of the ids joined by commas, order-sensitive', () => {
    expect(seriesHash([1, 2, 3])).toMatch(/^[0-9a-f]{16}$/);
    expect(seriesHash([1, 2, 3])).toBe('8a6ae15122001229');
    expect(seriesHash([3, 2, 1])).not.toBe(seriesHash([1, 2, 3]));
  });
});
