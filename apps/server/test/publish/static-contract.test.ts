import { LatestFile, SnapshotFile } from '@rws/contracts';
import { describe, expect, it } from 'vitest';

// P9a: a file whose every state is no_ref (a bucket before any reference exists, a family with no reference rows)
// has `bases: []` and `basis: [null, …]`. Regression: the contract once read a null basis as index 0 and refused
// such a file as "a basis index past bases", so the publisher could not write it. A real index past bases is refused.

const noRef = {
  schemaVersion: 1,
  t: '2026-10-04T12:00:00.000Z',
  series: [1, 2],
  ageSeconds: [0, 60],
  value: [100, 101],
  qc: [0, 0],
  state: ['no_ref', 'no_ref'],
  basis: [null, null],
  bases: [],
  section: [false, false],
  area: [null, null],
  nap: [null, null],
  zero: [null, null],
  attribution: [],
};

describe('a file of no_ref states only', () => {
  it('SnapshotFile accepts empty bases when every basis is null', () => {
    expect(SnapshotFile.safeParse(noRef).success).toBe(true);
  });
  it('LatestFile accepts empty bases when every basis is null', () => {
    const latest = {
      ...noRef,
      generatedAt: noRef.t,
      seriesHash: '0'.repeat(16),
      dh24: [null, null],
      dh1: [null, null],
    };
    expect(LatestFile.safeParse(latest).success).toBe(true);
  });
  it('refuses an index past bases', () => {
    expect(SnapshotFile.safeParse({ ...noRef, state: ['low', 'no_ref'], basis: [0, null] }).success).toBe(false);
    expect(SnapshotFile.safeParse({ ...noRef, area: [{ state: 'low', basis: 0 }, null] }).success).toBe(false);
  });
  it('control: the same file with one basis and one real state parses', () => {
    const base = { source: 'NL-1', kind: 'statistical', measure: 'stage', ref: 'MHW', label: 'x' };
    const file = { ...noRef, state: ['normal', 'no_ref'], basis: [0, null], bases: [base] };
    const r = SnapshotFile.safeParse(file);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
});
