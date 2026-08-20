/**
 * Planning for the latest poll: which upstream calls a set of live series
 * turns into. Pure, so it runs without a database or the network.
 */

import { describe, expect, it } from 'vitest';
import { planBatches } from '../src/ingest/latest.js';
import type { PollTarget } from '../src/db/series.js';

function target(overrides: Partial<PollTarget> = {}): PollTarget {
  return {
    id: 1,
    naturalKey: 'k',
    locationCode: 'vlissingen',
    compartiment: 'OW',
    grootheid: 'WATHTE',
    procesType: 'meting',
    parameter: null,
    meetapparaat: null,
    waardebepalingMethode: null,
    lastObservedAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('planBatches', () => {
  it('asks one filter for the locations that share it', () => {
    const batches = planBatches([
      target({ id: 1, naturalKey: 'a', locationCode: 'vlissingen' }),
      target({ id: 2, naturalKey: 'b', locationCode: 'hoekvanholland' }),
    ], 100, 2000);

    expect(batches).toHaveLength(1);
    expect(batches[0]!.locationCodes.sort()).toEqual(['hoekvanholland', 'vlissingen']);
    expect(batches[0]!.filters).toHaveLength(1);
    expect(batches[0]!.filters[0]).toMatchObject({ compartiment: 'OW', grootheid: 'WATHTE' });
  });

  it('carries the narrowing dimensions into the filter', () => {
    const [batch] = planBatches([
      target({ parameter: 'Cl', meetapparaat: '10042', waardebepalingMethode: 'other:F007' }),
    ], 100, 2000);

    expect(batch!.filters[0]).toEqual({
      compartiment: 'OW',
      grootheid: 'WATHTE',
      procesType: 'meting',
      parameter: 'Cl',
      meetapparaat: '10042',
      waardebepalingMethode: 'other:F007',
    });
  });

  it('gives each filterable difference its own filter', () => {
    const [batch] = planBatches([
      target({ id: 1, naturalKey: 'a', meetapparaat: '10042' }),
      target({ id: 2, naturalKey: 'b', meetapparaat: '10257' }),
      target({ id: 3, naturalKey: 'c', grootheid: 'T' }),
    ], 100, 2000);

    // One location, so all three pack into a single call.
    expect(batch!.filters).toHaveLength(3);
    expect(batch!.locationCodes).toEqual(['vlissingen']);
  });

  it('stops packing a call at the cross product it is allowed to ask for', () => {
    const targets = [
      ...Array.from({ length: 60 }, (_, i) =>
        target({ id: i, naturalKey: `a${i}`, locationCode: `loc${i}`, meetapparaat: '10042' })),
      ...Array.from({ length: 60 }, (_, i) =>
        target({ id: 100 + i, naturalKey: `b${i}`, locationCode: `other${i}`, meetapparaat: '10257' })),
    ];

    // Two filters over 120 distinct locations is 240 combinations; a cap of
    // 100 forces them apart, a generous one lets them share a call.
    expect(planBatches(targets, 100, 100)).toHaveLength(2);
    const packed = planBatches(targets, 100, 2000);
    expect(packed).toHaveLength(1);
    expect(packed[0]!.filters).toHaveLength(2);
    expect(packed[0]!.locationCodes).toHaveLength(120);
  });

  it('collapses series that differ only in something upstream cannot filter on', () => {
    // Two sampling heights at one station: distinct series to us, one request
    // upstream, and the response carries both.
    const batches = planBatches([
      target({ id: 1, naturalKey: 'height-0' }),
      target({ id: 2, naturalKey: 'height-1' }),
    ], 100, 2000);

    expect(batches).toHaveLength(1);
    expect(batches[0]!.filters).toHaveLength(1);
    expect(batches[0]!.locationCodes).toEqual(['vlissingen']);
  });

  it('splits a filter asked for at more locations than fit in one call', () => {
    const targets = Array.from({ length: 250 }, (_, i) =>
      target({ id: i, naturalKey: `k${i}`, locationCode: `loc${i}` }));

    // One filter per chunk, and a cap that keeps the chunks apart.
    const batches = planBatches(targets, 100, 100);

    expect(batches.map((b) => b.locationCodes.length)).toEqual([100, 100, 50]);
    expect(batches.every((b) => b.filters.length === 1)).toBe(true);
    expect(new Set(batches.flatMap((b) => b.locationCodes)).size).toBe(250);
  });

  it('never plans an empty or unbounded call', () => {
    expect(planBatches([], 100, 2000)).toEqual([]);
    // A batch size of zero would otherwise slice for ever, and a cross-product
    // cap below one batch must still let that batch through.
    expect(planBatches([target()], 0, 0)).toHaveLength(1);
  });
});
