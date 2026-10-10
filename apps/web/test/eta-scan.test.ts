import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiStation } from '@rws/contracts';
import { describe, expect, it } from 'vitest';
import { scanEta } from '../e2e/eta-scan.ts';
import { chain } from '../src/features/flow/chain.ts';
import { type ChainRow, chainRows } from '../src/features/flow/rows.ts';
import type { WebRiver } from '../src/lib/data/chain.ts';
import { ReachGraphFile, ReachTravel } from '../src/lib/data/contracts.ts';
import { travelPriorOf, travelText } from '../src/lib/travel.ts';
import type { Locale } from '../src/paraglide/runtime.js';
import { PRIORS } from './fixtures/travel-priors.ts';

const web = join(import.meta.dirname, '..');
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const LOCALES: Locale[] = ['nl', 'en'];

interface Neg {
  text: string;
  travelRow: boolean;
  rules?: string[];
}
const cases = json(join(import.meta.dirname, 'fixtures', 'eta-negative.json')) as { negative: Neg[]; positive: Neg[] };

describe('scanEta', () => {
  it.each(cases.negative.map((c) => [c.text, c] as const))('reports %s', (_t, c) => {
    const found = scanEta([{ where: 'x', text: c.text, travelRow: c.travelRow }]).map((v) => v.rule);
    for (const rule of c.rules ?? []) expect(found).toContain(rule);
  });

  it('reports nothing for the positive controls', () => {
    expect(scanEta(cases.positive.map((c) => ({ where: 'p', text: c.text, travelRow: c.travelRow })))).toEqual([]);
  });

  it('never echoes the text', () => {
    const [v] = scanEta([{ where: 'w', text: 'aankomst 14:00' }]);
    expect(v).toEqual({ where: 'w', rule: 'aankomst' });
  });
});

describe('the site texts', () => {
  it('no message of either language trips a rule', () => {
    const items = LOCALES.flatMap((l) =>
      Object.entries(json(join(web, 'messages', `${l}.json`)) as Record<string, unknown>)
        .filter((e): e is [string, string] => typeof e[1] === 'string')
        .map(([key, text]) => ({ where: `${l}:${key}`, text, travelRow: key.startsWith('travel_') })),
    );
    expect(items.length).toBeGreaterThan(100);
    expect(scanEta(items)).toEqual([]);
  });

  it('the time-shift legend note (#112) says indicative and holds no ETA, as a travel row too', () => {
    for (const [l, word] of [
      ['nl', 'indicatief'],
      ['en', 'indicative'],
    ] as const) {
      const text = (json(join(web, 'messages', `${l}.json`)) as Record<string, unknown>).reach_shifted;
      expect(typeof text, l).toBe('string');
      expect(text as string, l).toContain(word);
      expect(scanEta([{ where: `${l}:reach_shifted`, text: text as string, travelRow: true }])).toEqual([]);
    }
  });

  it('every golden prior and every fixture travel pair, as travel rows', () => {
    const file = json(join(import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'reaches-fixture.json'));
    const pairs = ReachTravel.parse(file).travel_times;
    expect(pairs.length).toBeGreaterThan(0);
    const items = LOCALES.flatMap((l) => [
      ...PRIORS.map((p) => ({ where: `${l}:${p.id}`, text: travelText(p.prior, l) })),
      ...pairs.map((t) => ({
        where: `${l}:${t.from_station_id}`,
        text: travelText(travelPriorOf(t), l),
      })),
    ]);
    const shown = items.flatMap((i) => (i.text === null ? [] : [{ where: i.where, text: i.text, travelRow: true }]));
    expect(shown.length).toBeGreaterThan(pairs.length);
    expect(scanEta(shown)).toEqual([]);
  });

  it('the upstream chain rows of Lobith, Nijmegen and Eijsden, as travel rows', () => {
    const file = json(join(import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'reaches-fixture.json')) as {
      rivers: WebRiver[];
      stations: { id: string }[];
    };
    const graph = ReachGraphFile.parse(file);
    const travel = ReachTravel.parse(file);
    const stations = new Map(
      file.stations.map((s) => [s.id, { id: s.id, name: s.id, series: [] } as unknown as ApiStation]),
    );
    const known = new Set(stations.keys());
    const rivers = new Map(file.rivers.map((r) => [r.id, r]));
    const flat = (rows: readonly ChainRow[]): ChainRow[] =>
      rows.flatMap((r) => (r.kind === 'group' ? [r, ...flat(r.children)] : [r]));
    for (const target of ['nl.rws.lobith.bovenrijn.tolkamer', 'nl.rws.nijmegen.waal', 'nl.rws.eijsden.grens']) {
      for (const locale of LOCALES) {
        const rows = flat(
          chainRows(chain(graph, file.rivers, target, known), {
            locale,
            targetId: target,
            stations,
            rivers,
            states: new Map(),
            values: new Map(),
            ownerSources: new Set(),
            travel,
          }),
        );
        expect(rows.length, `${locale}:${target}`).toBeGreaterThan(0);
        const items = rows.flatMap((r) =>
          r.kind === 'station'
            ? [
                { where: `${locale}:${target}:${r.id}:travel`, text: r.travel, travelRow: true },
                ...(r.travelBasis === null
                  ? []
                  : [{ where: `${locale}:${target}:${r.id}:basis`, text: r.travelBasis }]),
                ...(r.source === null ? [] : [{ where: `${locale}:${target}:${r.id}:source`, text: r.source }]),
              ]
            : [{ where: `${locale}:${target}:${r.key}`, text: r.kind === 'gap' ? r.text : r.summary }],
        );
        expect(scanEta(items)).toEqual([]);
      }
    }
  });
});
