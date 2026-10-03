import { Snapshot } from '@rws/contracts';
import type { Classified } from '@rws/core';
import { describe, expect, it } from 'vitest';
import { publicSnapshot } from '../../src/api/data.ts';
import { classCoverage, type StateRead } from '../../src/api/states.ts';
import { errorCode } from '../../src/db/pool.ts';

// The pure parts of the P7b read on hand-made reads: the coverage report (review CR-4) and the owner-source check at
// the public snapshot's boundary (review SR-5).

const T = Date.UTC(2026, 9, 26, 12);
const FLAGS = { stale: false, suspect: false, tidal: false, impounded: false };
const basis = (source: string, kind: 'operational' | 'area' = 'operational') => ({
  source,
  kind,
  measure: kind === 'area' ? ('area' as const) : ('stage' as const),
  ref: 'x',
  label: `${source} x`,
});
const gauge = (source = 'DE-1'): Classified => ({
  state: 'normal',
  basis: basis(source),
  section: false,
  area: null,
  flags: FLAGS,
});
const section = (source = 'FR-5'): Classified => ({
  state: 'normal',
  basis: basis(source, 'area'),
  section: true,
  area: null,
  flags: FLAGS,
});
const none: Classified = { state: 'no_ref', basis: null, section: false, area: null, flags: FLAGS };

/** A read of one series per entry: [station, country, classified]; every station is tier 1 and public. */
function read(entries: [string, 'DE' | 'FR', Classified][]): StateRead {
  return {
    t: T,
    stations: [...new Set(entries.map(([s, c]) => `${s}\n${c}`))].map((k) => {
      const [id, country] = k.split('\n') as [string, 'DE' | 'FR'];
      return { id, country, lon: null, lat: null, tier: 1, flags: null };
    }),
    series: entries.map(([station, , classified], i) => ({
      series: i + 1,
      station,
      source: 'DE-1',
      obs: { ts: new Date(T - 600_000), value: 100, qc: 1 },
      classified,
      height: null,
    })),
    publicSeries: new Set(entries.map((_, i) => i + 1)),
  };
}

describe('classCoverage: by_section and the D10 mode (review CR-4)', () => {
  it('counts section-only stations in classed and by_section; a gauge state anywhere is not by section', () => {
    const c = classCoverage(
      read([
        ['a', 'DE', gauge()],
        ['b', 'FR', section()],
        ['c', 'FR', section()],
        ['c', 'FR', gauge('DE-1')],
        ['d', 'FR', none],
      ]),
    );
    expect(c.tier1).toEqual({ stations: 4, classed: 3, by_section: 1, ratio: 0.75 });
    expect(c.countries.find((x) => x.country === 'FR')?.tier1).toEqual({
      stations: 3,
      classed: 2,
      by_section: 1,
      ratio: 2 / 3,
    });
    // (3 − 1) / 4 = 0.5: under 60 % with gauge states, although 75 % are classed.
    expect(c.mode).toBe('dh');
  });

  it('mode is state at 60 % of stations with a gauge state', () => {
    const c = classCoverage(
      read([
        ['a', 'DE', gauge()],
        ['b', 'DE', gauge()],
        ['c', 'DE', gauge()],
        ['d', 'DE', section()],
        ['e', 'DE', none],
      ]),
    );
    expect(c.tier1).toMatchObject({ classed: 4, by_section: 1 });
    expect(c.mode).toBe('state');
  });

  it('first release counts sources that need no permission, by_section among them', () => {
    const c = classCoverage(
      read([
        ['a', 'DE', section('DE-10')],
        ['b', 'DE', section('LU-5')],
        ['c', 'DE', gauge('DE-9')],
      ]),
    );
    expect(c.first_release).toEqual({ stations: 3, classed: 1, by_section: 1, ratio: 1 / 3 });
  });

  it('no stations: dh and a null ratio', () => {
    expect(classCoverage(read([]))).toMatchObject({
      mode: 'dh',
      tier1: { stations: 0, classed: 0, by_section: 0, ratio: null },
    });
  });
});

describe('publicSnapshot fails closed on an owner-only source (review SR-5)', () => {
  it('passes a public read through the contract', () => {
    const snap = publicSnapshot(read([['a', 'DE', gauge()]]));
    expect(Snapshot.safeParse(snap).success).toBe(true);
    expect(snap.values[0]).toMatchObject({ state: 'normal', basis: { source: 'DE-1' } });
  });

  for (const source of ['LU-4', 'BE-3']) {
    it(`a ${source} basis, or a ${source} area beside a public state, throws the fixed code owner_basis`, () => {
      const asBasis = read([['a', 'DE', gauge(source)]]);
      const asArea = read([['a', 'DE', { ...gauge(), area: { state: 'high', basis: basis(source, 'area') } }]]);
      for (const r of [asBasis, asArea]) {
        let thrown: unknown;
        try {
          publicSnapshot(r);
        } catch (err) {
          thrown = err;
        }
        expect(errorCode(thrown)).toBe('owner_basis');
        expect(String((thrown as Error).message)).not.toContain(source);
      }
    });
  }
});
