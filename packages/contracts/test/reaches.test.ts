import { describe, expect, it } from 'vitest';
import { StationTravelTime } from '../src/reaches.ts';

// The v2 travel shape (#110) of the reaches file: h or d, a range or a labelled single value, derived only true.
// A row of the pre-#110 files (an h range alone) stays valid, so schema_version stays 1.

const row = (over: Record<string, unknown> = {}) => ({
  from_station_id: 'de.wsv.2790020',
  to_station_id: 'nl.rws.lobith.bovenrijn.tolkamer',
  h: [1, 8],
  basis: 'flood peak',
  source: 'a note',
  source_url: 'https://example.org/note',
  ...over,
});
const label = { nl: 'hoogwater', en: 'flood' };
const omit = (r: Record<string, unknown>, k: string) => Object.fromEntries(Object.entries(r).filter(([x]) => x !== k));

describe('StationTravelTime', () => {
  it('keeps a pre-#110 row valid', () => {
    expect(StationTravelTime.safeParse(row()).success).toBe(true);
  });

  it('accepts a d range, a labelled single h, a labelled single d and derived true', () => {
    for (const r of [
      omit(row({ d: [4, 5] }), 'h'),
      row({ h: 23, label }),
      omit(row({ d: 2, label }), 'h'),
      row({ derived: true }),
    ])
      expect(StationTravelTime.safeParse(r).success, JSON.stringify(r)).toBe(true);
  });

  it('refuses the bad shapes', () => {
    for (const r of [
      omit(row(), 'h'),
      row({ d: [1, 2] }),
      row({ h: 23 }),
      row({ h: [8, 1] }),
      row({ h: [3, 3] }),
      row({ h: 0, label }),
      row({ derived: false }),
      row({ h: 23, label: { nl: 'x', en: '' } }),
      row({ h: 23, label: { nl: 'x', en: 'x', de: 'x' } }),
      row({ extra: 1 }),
    ])
      expect(StationTravelTime.safeParse(r).success, JSON.stringify(r)).toBe(false);
  });
});
