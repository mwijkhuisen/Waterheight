import { existsSync } from 'node:fs';
import { obsParts } from '@rws/core';
import { describe, expect, it } from 'vitest';
import { discover } from '../../src/adapters/nl-2/normalise.ts';
import { parseCollection } from '../../src/adapters/nl-2/parse.ts';
import { LOAD_ADAPTERS } from '../../src/load/adapters.ts';
import { rawFixture, registryOf } from './registry.ts';

// The real DST regression set (issue #55, moved out of P5b so that P5b merges before the night; catalogue §0.3):
// payloads that the recorder archived during the fall-back night of 2026-10-25 (the local hour 02:00–02:59
// occurred twice, from 01:00Z), one source each, asserting exact UTC instants between 00:00Z and 03:00Z. The
// owner exports them after that night (Action D2, the script in #55) and `scripts/import-fixtures.ts` imports
// them as `<source>/fixtures/<name>.raw` with `from: archive`.
//
// The switch: `PENDING` lists the sources whose payload has not been imported yet. The test fails if a pending
// source already has its fixture, or a source no longer pending lacks it, so the set can be neither forgotten
// nor skipped silently. Remove a source from PENDING in the change that adds its fixture.
export const PENDING: readonly string[] = ['DE-1', 'NL-1', 'NL-2', 'FR-1', 'CH-1', 'DE-7', 'LU-1'];

const FROM = Date.parse('2026-10-25T00:00:00Z');
const TO = Date.parse('2026-10-25T03:00:00Z');

/**
 * Per source: the fixture, its spec, the series checked and its step. Every instant of that series between
 * 00:00Z and 03:00Z must lie on the step's grid, once, with none missing (NL-2, a snapshot of latest values:
 * each instant at most 70 minutes before the payload's fetch and never after it, A§7.4 step 2).
 */
const SET: Readonly<Record<string, { fixture: string; spec: string; series: string; stepMin: number }>> = {
  'DE-1': {
    fixture: 'de-1-series-dst-2026-10-25',
    spec: 'de-1-series',
    series: 'c263ea53-ca4d-41f5-b3f5-6178fec302aa/W',
    stepMin: 15,
  },
  'NL-1': {
    fixture: 'nl-1-obs-key-dst-2026-10-25',
    spec: 'nl-1-obs-key',
    series: 'lobith.bovenrijn.tolkamer/WATHTE/NAP/other:F007',
    stepMin: 10,
  },
  'NL-2': {
    fixture: 'nl-2-wfs-dst-2026-10-25',
    spec: 'nl-2-wfs',
    series: 'lobith.bovenrijn.tolkamer/WATHTE/NAP/other:F007',
    stepMin: 10,
  },
  'FR-1': { fixture: 'fr-1-obs-dst-2026-10-25', spec: 'fr-1-obs', series: 'B720000001/H', stepMin: 5 },
  'CH-1': { fixture: 'ch-1-lindas-dst-2026-10-25', spec: 'ch-1-lindas', series: '2289/W', stepMin: 10 },
  'DE-7': { fixture: 'de-7-messwerte-dst-2026-10-25', spec: 'de-7-messwerte', series: '2829100000100/W', stepMin: 15 },
  'LU-1': { fixture: 'lu-1-csv-dst-2026-10-25', spec: 'lu-1-csv', series: 'Diekirch', stepMin: 15 },
};

const fixtureUrl = (source: string) =>
  new URL(`../../src/adapters/${source.toLowerCase()}/fixtures/${SET[source]?.fixture}.raw`, import.meta.url);

describe('the real DST set of 2026-10-25', () => {
  it('lists the seven sources of issue #20, and the pending switch matches the fixtures on disk', () => {
    expect(Object.keys(SET).sort()).toEqual(['CH-1', 'DE-1', 'DE-7', 'FR-1', 'LU-1', 'NL-1', 'NL-2']);
    for (const source of Object.keys(SET)) {
      expect([source, existsSync(fixtureUrl(source))]).toEqual([source, !PENDING.includes(source)]);
    }
  });

  for (const source of Object.keys(SET).filter((s) => !PENDING.includes(s))) {
    it(`${source}: exact UTC instants through the repeated hour`, async () => {
      const { fixture, spec, series, stepMin } = SET[source] as (typeof SET)[string];
      const { body, meta } = rawFixture(source, fixture);
      const fetchedAt = Date.parse(meta.recorded_at);
      const run = LOAD_ADAPTERS[source]?.specs[spec]?.run;
      expect(run).toBeDefined();
      const out = await (run as NonNullable<typeof run>)(body, {
        registry: registryOf(source === 'NL-2' ? 'NL-1' : source),
        fetchedAt,
        variant: source === 'DE-1' ? series : '',
        unitMismatch: new Set(),
      });
      const ts = [...obsParts(out)]
        .flat()
        .filter((r) => r.series === series)
        .map((r) => Date.parse(r.ts))
        .filter((t) => t >= FROM && t < TO);
      if (source === 'NL-2') {
        // NL-2 stores nothing (REST wins); its local time labelled Z must resolve to an instant at most 70
        // minutes before the payload's own fetch, never after it: the repeated hour agrees with fetched_at.
        const found = discover(parseCollection(body)).series.find((s) => s.key === series);
        expect(found).toBeDefined();
        const at = Date.parse((found as { ts: string }).ts);
        expect(at).toBeLessThanOrEqual(fetchedAt);
        expect(at).toBeGreaterThanOrEqual(fetchedAt - 70 * 60_000);
        return;
      }
      const grid = Array.from({ length: (TO - FROM) / (stepMin * 60_000) }, (_, i) => FROM + i * stepMin * 60_000);
      expect(ts.map((t) => new Date(t).toISOString())).toEqual(grid.map((t) => new Date(t).toISOString()));
    });
  }
});
