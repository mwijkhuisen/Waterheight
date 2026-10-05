import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  dayOf,
  FramesFile,
  framesPath,
  isSettled,
  LatestFile,
  recentPath,
  SnapshotFile,
  StaticForecastLatest,
  StaticMeta,
  StaticStations,
  StationRecent,
  settledPath,
  toSnapshot,
  WarningsFile,
} from '../src/static.ts';
import {
  OwnerLatestFile,
  OwnerSnapshotFile,
  OwnerStaticMeta,
  OwnerStaticSources,
  OwnerStationRecent,
  OwnerWarningsFile,
  StaticSources,
} from '../src/static-owner.ts';
import { OwnerStatusFile, StatusFile } from '../src/status.ts';

const T = Date.parse('2026-10-25T01:50:00Z');

describe('static paths and the settled rule (P9a)', () => {
  it('names a bucket by its UTC day and start', () => {
    expect(recentPath(T)).toBe('recent/2026-10-25/0150.json');
    expect(settledPath(T, 3)).toBe('settled/2026-10-25/v3/0150.json');
    expect(framesPath('2026-10-25', 1)).toBe('frames/2026-10-25/v1.json');
  });

  it('gives the 2026-10-25 DST day 144 distinct UTC buckets', () => {
    const start = Date.parse('2026-10-25T00:00:00Z');
    const paths = new Set(Array.from({ length: 144 }, (_, i) => recentPath(start + i * 600_000)));
    expect(paths.size).toBe(144);
    expect(dayOf(start + 143 * 600_000)).toBe('2026-10-25');
  });

  it('settles a day once its end is 48 hours old', () => {
    const end = Date.parse('2026-10-26T00:00:00Z');
    expect(isSettled('2026-10-25', end + 48 * 3_600_000)).toBe(true);
    expect(isSettled('2026-10-25', end + 48 * 3_600_000 - 1)).toBe(false);
  });
});

const columns = {
  schemaVersion: 1 as const,
  t: '2026-10-26T12:00:00.000Z',
  series: [5, 9],
  ageSeconds: [600, 0],
  value: [101.5, 7],
  qc: [0, 512],
  state: ['high', 'no_ref'] as ('high' | 'no_ref')[],
  basis: [0, null],
  bases: [{ source: 'NL-1', kind: 'operational' as const, measure: 'stage' as const, ref: 'NL4:x', label: 'Hoog' }],
  section: [false, false],
  area: [{ state: 'elevated' as const, basis: 0 }, null],
  nap: [{ m: 1.2, pm: 0.01 }, null],
  zero: [null, null],
  attribution: [],
};

describe('snapshot files', () => {
  it('rebuilds the API snapshot, ordered by series', () => {
    const file = SnapshotFile.parse(columns);
    const s = toSnapshot(file);
    expect(s.values.map((v) => v.series)).toEqual([5, 9]);
    expect(s.values[0]).toMatchObject({
      ts: '2026-10-26T11:50:00.000Z',
      basis: columns.bases[0],
      area: { state: 'elevated', basis: columns.bases[0] },
      nap: { m: 1.2, pm: 0.01 },
    });
    expect(s.values[1]).toMatchObject({ basis: null, ageSeconds: 0 });
    expect(s.values[1]).not.toHaveProperty('area');
  });

  it('refuses a short column, an unordered series, a basis past bases and a canary id in a public file', () => {
    expect(SnapshotFile.safeParse({ ...columns, qc: [0] }).success).toBe(false);
    expect(SnapshotFile.safeParse({ ...columns, series: [9, 5] }).success).toBe(false);
    expect(SnapshotFile.safeParse({ ...columns, basis: [1, null] }).success).toBe(false);
    const canary = { ...columns, bases: [{ ...columns.bases[0], source: 'CANARY-OWNER' }] };
    expect(SnapshotFile.safeParse(canary).success).toBe(false);
    expect(OwnerSnapshotFile.safeParse(canary).success).toBe(true);
  });

  it('latest.json keeps stations.json order and two Δh columns', () => {
    const latest = {
      ...columns,
      series: [9, 5],
      generatedAt: columns.t,
      seriesHash: '0123456789abcdef',
      dh24: [1, null],
      dh1: [null, 0],
    };
    expect(LatestFile.safeParse(latest).success).toBe(true);
    expect(LatestFile.safeParse({ ...latest, dh1: [null] }).success).toBe(false);
    expect(OwnerLatestFile.safeParse(latest).success).toBe(true);
  });
});

describe('warnings files', () => {
  const file = {
    type: 'FeatureCollection',
    schemaVersion: 1,
    generatedAt: '2026-10-25T02:00:00.000Z',
    day: null,
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6, 50],
              [7, 50],
              [7, 51],
              [6, 50],
            ],
          ],
        },
        properties: {
          source: 'LU-5',
          area: 'zone-1',
          name: 'Zone 1',
          level: 3,
          levelRaw: 'Moderate',
          label: null,
          from: '2026-10-25T00:00:00.000Z',
          to: null,
          issuedAt: null,
        },
      },
    ],
    attribution: [],
  };
  it('takes number coordinates only and refuses a canary source in public', () => {
    expect(WarningsFile.safeParse(file).success).toBe(true);
    const bad = structuredClone(file);
    (bad.features[0] as { geometry: { coordinates: unknown } }).geometry.coordinates = [[['6', 50]]];
    expect(WarningsFile.safeParse(bad).success).toBe(false);
    const canary = structuredClone(file);
    (canary.features[0] as { properties: { source: string } }).properties.source = 'CANARY-OWNER';
    expect(WarningsFile.safeParse(canary).success).toBe(false);
    expect(OwnerWarningsFile.safeParse(canary).success).toBe(true);
  });
});

describe('every file contract has a JSON Schema', () => {
  it.each(
    Object.entries({
      SnapshotFile,
      LatestFile,
      StaticMeta,
      StaticStations,
      FramesFile,
      StationRecent,
      StaticForecastLatest,
      StaticSources,
      StatusFile,
      WarningsFile,
      OwnerWarningsFile,
      OwnerSnapshotFile,
      OwnerLatestFile,
      OwnerStaticMeta,
      OwnerStationRecent,
      OwnerStaticSources,
      OwnerStatusFile,
    }),
  )('%s', (_, schema) => {
    expect(() => z.toJSONSchema(schema, { unrepresentable: 'throw' })).not.toThrow();
  });
});
