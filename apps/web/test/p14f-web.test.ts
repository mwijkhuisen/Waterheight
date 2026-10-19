import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiStation } from '@rws/contracts';
import { describe, expect, it } from 'vitest';
import { scanEta } from '../e2e/eta-scan.ts';
import { chain } from '../src/features/flow/chain.ts';
import { shiftHours } from '../src/features/flow/reaches/shift.ts';
import { type ChainRow, chainRows } from '../src/features/flow/rows.ts';
import { referenceRows } from '../src/features/pages/parts/method.ts';
import { travelRows } from '../src/features/pages/parts/travel.ts';
import { basisKind } from '../src/features/station/state.ts';
import type { WebRiver } from '../src/lib/data/chain.ts';
import { ReachGraphFile, ReachTravel } from '../src/lib/data/contracts.ts';
import type { Locale } from '../src/paraglide/runtime.js';

// P14f (package D): the day-of-year basis text, the Method page's "own computation" agency and the empirical derived
// travel pair (the fact sheet's strings, digit-free basis) through the ETA scan.

const LOCALES: Locale[] = ['nl', 'en'];
const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'reaches-fixture.json'), 'utf8'),
) as { rivers: WebRiver[]; stations: { id: string }[]; travel_times: Record<string, unknown>[] };

const EMPIRICAL = {
  h: [2, 4],
  derived: true,
  basis: 'empirical: cross-correlation of level or discharge changes by flow class',
  source: 'Water Radar (own computation)',
  source_url: 'https://github.com/mwijkhuisen/Waterheight/blob/main/registry/travel-empirical.yaml',
};

describe('basisKind with a day-of-year reference', () => {
  const statistical = { kind: 'statistical', source: 'NL-1' } as const;
  it.each([
    ['nl', 'eigen seizoensklimatologie (P10–P90 per dag van het jaar)'],
    ['en', 'own seasonal climatology (day-of-year P10–P90)'],
  ] as const)('names it (%s)', (locale, text) => {
    for (const ref of ['P10_DOY', 'P10_DOY/P90_DOY', 'P90_DOY', 'MNW/MHW/P90_DOY'])
      expect(basisKind({ ...statistical, ref }, locale)).toBe(text);
  });
  it('other statistical references keep the statistical text', () => {
    expect(basisKind({ ...statistical, ref: 'MNW/MHW' }, 'en')).toBe('statistical reference');
    expect(basisKind(statistical, 'nl')).toBe('statistische referentie');
  });
});

describe('the Method page reference rows', () => {
  it.each(LOCALES)('a row of source * has our own computation as its agency (%s)', (locale) => {
    const own = referenceRows(locale).filter((r) => r.source === '*');
    expect(own.length).toBeGreaterThanOrEqual(2);
    for (const r of own) {
      expect(r.agency).toBe(locale === 'nl' ? 'eigen berekening' : 'own computation');
      // The role's basis is a placeholder ('stage'): the set follows its series, a level or a discharge.
      expect(r.measure).toBe(locale === 'nl' ? 'waterstand of afvoer' : 'level or discharge');
      expect(r.form).toBe(
        locale === 'nl'
          ? 'seizoensklimatologie (percentiel per dag van het jaar)'
          : 'seasonal climatology (percentile per day of the year)',
      );
      expect(r.group).toBe(
        locale === 'nl'
          ? 'eigen seizoensklimatologie (P10–P90 per dag van het jaar)'
          : 'own seasonal climatology (day-of-year P10–P90)',
      );
    }
  });
});

describe('an empirical derived travel pair', () => {
  it('is a derived range, never shifted', () => {
    const pair = { from_station_id: 'de.wsv.2790020', to_station_id: 'nl.rws.lobith.bovenrijn.tolkamer', ...EMPIRICAL };
    const t = ReachTravel.parse({ travel_times: [pair] }).travel_times;
    expect(t).toHaveLength(1);
    expect(shiftHours(t[0] as never)).toBeNull();
    expect(travelRows({ travel_times: t }, new Map(), 'en')[0]?.range).toBe('indicative: 2–4 h (derived)');
    expect(travelRows({ travel_times: t }, new Map(), 'nl')[0]?.range).toBe('indicatief: 2–4 u (afgeleid)');
  });

  it('passes the ETA scan in the Method table and in the upstream chain rows', () => {
    const [first] = fixture.travel_times;
    const target = String(first?.to_station_id);
    const file = { ...fixture, travel_times: [{ ...first, ...EMPIRICAL }, ...fixture.travel_times.slice(1)] };
    const graph = ReachGraphFile.parse(file);
    const travel = ReachTravel.parse(file);
    const stations = new Map(
      file.stations.map((s) => [s.id, { id: s.id, name: s.id, series: [] } as unknown as ApiStation]),
    );
    const flat = (rows: readonly ChainRow[]): ChainRow[] =>
      rows.flatMap((r) => (r.kind === 'group' ? [r, ...flat(r.children)] : [r]));
    const items: { where: string; text: string; travelRow?: boolean }[] = [];
    for (const locale of LOCALES) {
      for (const r of travelRows(travel, new Map(), locale))
        items.push(
          { where: `${locale}:m:range`, text: r.range, travelRow: true },
          { where: `${locale}:m:basis`, text: r.basis },
          { where: `${locale}:m:source`, text: r.source },
        );
      const rows = flat(
        chainRows(chain(graph, file.rivers, target, new Set(stations.keys())), {
          locale,
          targetId: target,
          stations,
          rivers: new Map(file.rivers.map((r) => [r.id, r])),
          states: new Map(),
          values: new Map(),
          ownerSources: new Set(),
          travel,
        }),
      );
      for (const r of rows)
        if (r.kind === 'station') {
          items.push({ where: `${locale}:c:${r.id}`, text: r.travel, travelRow: true });
          if (r.travelBasis !== null) items.push({ where: `${locale}:c:b`, text: r.travelBasis });
        }
    }
    expect(items.some((i) => i.text.includes('2–4'))).toBe(true);
    expect(scanEta(items)).toEqual([]);
  });
});
