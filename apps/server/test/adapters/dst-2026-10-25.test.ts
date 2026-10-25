import { existsSync } from 'node:fs';
import { obsParts } from '@rws/core';
import { describe, expect, it } from 'vitest';
import { discover } from '../../src/adapters/nl-2/normalise.ts';
import { parseCollection } from '../../src/adapters/nl-2/parse.ts';
import { LOAD_ADAPTERS } from '../../src/load/adapters.ts';
import { scoreShifts } from '../../src/load/align.ts';
import { MARGIN, OFFSET_PAIR, OFFSET_SHIFTS } from '../../src/load/label-offset.ts';
import { rawFixture, registryOf } from './registry.ts';

// The real DST regression set (issue #55, moved out of P5b so that P5b merges before the night; catalogue §0.3):
// payloads that the recorder archived during the fall-back night of 2026-10-25 (the local hour 02:00–02:59
// occurred twice, from 01:00Z), asserting exact UTC instants between 00:00Z and 03:00Z through the loader's own
// specs. The owner exported them after that night (Action D2, the two scripts in #55) and
// `node scripts/import-fixtures.ts --dst` imported them (`IMPORTS_DST`) as `<source>/fixtures/<name>.raw` with
// `from: archive`, cut only by its committed rules.
//
// The switch: `PENDING` lists the sources whose payload has not been imported yet. The test fails if a pending
// source already has its fixtures, or a source no longer pending lacks one, so the set can be neither forgotten
// nor skipped silently. Empty since #55.
//
// P8a added the NL-1 forecast spec (key 'NL-1 forecast'): a `verwachting` capture fetched before 2026-10-24T23:50Z
// (a forecast reaches 48 h ahead, so it holds the whole night), whose run is checked like an observation series.
export const PENDING: readonly string[] = [];

const FROM = Date.parse('2026-10-25T00:00:00Z');
const TO = Date.parse('2026-10-25T03:00:00Z');
const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();

/** The fixtures of a stem fetched at the given UTC times (HHMM), in that order: `<stem>-2026-10-25t<HHMM>z`. */
const fetched = (stem: string, times: readonly string[]) => times.map((t) => `${stem}-2026-10-25t${t}z`);

type Entry = {
  fixtures: readonly string[];
  spec: string;
  series: string;
  stepMin: number;
  source?: string;
  forecast?: true;
  snapshots?: true;
};

/**
 * Per source: its fixtures (in fetch order), their spec, the series checked and its step. Every instant of that
 * series between 00:00Z and 03:00Z lies on the step's grid, once in each payload, and the payloads together hold
 * the whole grid (NL-1: each capture reaches three hours back while RWS lags 15–25 minutes, so the captures of
 * 02:51Z and 03:11Z hold 16 of the 18 instants each). A snapshot source (`snapshots`: a list of the latest value per
 * series, NL-2 and CH-1) cannot hold a grid: each payload's instant lies at most 70 minutes before that payload's
 * fetch and never after it (A§7.4 step 2), and never goes back from one snapshot to the next; its snapshots span
 * both passes of the repeated hour (NL-2 00:55–02:05Z, CH-1 00:04–01:54Z).
 */
const SET: Readonly<Record<string, Entry>> = {
  'DE-1': {
    fixtures: ['de-1-series-dst-2026-10-25'],
    spec: 'de-1-series',
    series: 'c263ea53-ca4d-41f5-b3f5-6178fec302aa/W',
    stepMin: 15,
  },
  'NL-1': {
    fixtures: fetched('nl-1-obs-key-dst', ['0251', '0311']),
    spec: 'nl-1-obs-key',
    series: 'lobith.bovenrijn.tolkamer/WATHTE/NAP/other:F007',
    stepMin: 10,
  },
  'NL-1 forecast': {
    source: 'NL-1',
    forecast: true,
    fixtures: ['nl-1-fc-1h-dst-2026-10-25'],
    spec: 'nl-1-fc-1h',
    series: 'lobith.bovenrijn.tolkamer/Q/NVT/other:F230',
    stepMin: 10,
  },
  'NL-2': {
    snapshots: true,
    fixtures: fetched('nl-2-wfs-dst', ['0055', '0105', '0115', '0125', '0135', '0145', '0155', '0205']),
    spec: 'nl-2-wfs',
    series: 'lobith.bovenrijn.tolkamer/WATHTE/NAP/other:F007',
    stepMin: 10,
  },
  'FR-1': { fixtures: ['fr-1-obs-dst-2026-10-25'], spec: 'fr-1-obs', series: 'B720000001/H', stepMin: 5 },
  'CH-1': {
    snapshots: true,
    fixtures: fetched('ch-1-lindas-dst', [
      '0004',
      '0014',
      '0024',
      '0034',
      '0044',
      '0104',
      '0114',
      '0124',
      '0134',
      '0144',
      '0154',
    ]),
    spec: 'ch-1-lindas',
    series: '2289/W',
    stepMin: 10,
  },
  'DE-7': {
    fixtures: ['de-7-messwerte-dst-2026-10-25'],
    spec: 'de-7-messwerte',
    series: '2829100000100/W',
    stepMin: 15,
  },
  'LU-1': { fixtures: ['lu-1-csv-dst-2026-10-25'], spec: 'lu-1-csv', series: 'Diekirch', stepMin: 15 },
};

/** The source of a set entry (its key, but for the NL-1 forecast spec). */
const sourceOf = (key: string) => SET[key]?.source ?? key;
const fixtureUrl = (key: string, fixture: string) =>
  new URL(`../../src/adapters/${sourceOf(key).toLowerCase()}/fixtures/${fixture}.raw`, import.meta.url);

/** Each registry parsed once (NL-1's and CH-1's are about 300 KB; NL-2 and CH-1 run a dozen snapshots each). */
const registries = new Map<string, ReturnType<typeof registryOf>>();
const registryFor = (source: string) =>
  registries.get(source) ?? (registries.set(source, registryOf(source)).get(source) as ReturnType<typeof registryOf>);

/** One fixture of a set entry through the loader's own spec: its body, its fetch (the manifest's fetched_at), the output. */
async function load(key: string, fixture: string) {
  const source = sourceOf(key);
  const { spec, series } = SET[key] as Entry;
  const { body, meta } = rawFixture(source, fixture);
  const fetchedAt = Date.parse(meta.recorded_at);
  const run = LOAD_ADAPTERS[source]?.specs[spec]?.run;
  expect(run).toBeDefined();
  const out = await (run as NonNullable<typeof run>)(body, {
    registry: registryFor(source === 'NL-2' ? 'NL-1' : source),
    fetchedAt,
    variant: source === 'DE-1' ? series : '',
    unitMismatch: new Set(),
  });
  return { body, fetchedAt, out };
}

describe('the real DST set of 2026-10-25', () => {
  it('lists the seven sources of issue #20 and the NL-1 forecast spec, and the pending switch matches the fixtures on disk', () => {
    expect(Object.keys(SET).sort()).toEqual(['CH-1', 'DE-1', 'DE-7', 'FR-1', 'LU-1', 'NL-1', 'NL-1 forecast', 'NL-2']);
    for (const [key, { fixtures }] of Object.entries(SET)) {
      expect(fixtures.length).toBeGreaterThan(0);
      for (const f of fixtures)
        expect([key, f, existsSync(fixtureUrl(key, f))]).toEqual([key, f, !PENDING.includes(key)]);
    }
  });

  for (const key of Object.keys(SET).filter((k) => !PENDING.includes(k))) {
    it(`${key}: exact UTC instants through the repeated hour`, async () => {
      const { fixtures, series, stepMin, forecast, snapshots } = SET[key] as Entry;
      const instants: number[][] = [];
      for (const fixture of fixtures) {
        const { body, fetchedAt, out } = await load(key, fixture);
        const ts = (
          forecast === true
            ? (out.forecasts ?? []).filter((r) => r.series === series).flatMap((r) => r.points)
            : [...obsParts(out)].flat().filter((r) => r.series === series)
        ).map((r) => Date.parse(r.ts));
        if (snapshots !== true) {
          instants.push(ts.filter((t) => t >= FROM && t < TO));
          continue;
        }
        // One latest instant per snapshot, not cut to the window (CH-1's first two state 23:40Z and 23:50Z). NL-2
        // stores nothing (REST wins), so its instant is the snapshot's own: its local time labelled Z resolves
        // against the collection's timeStamp, and the repeated hour must agree with the payload's fetched_at.
        let latest = ts;
        if (sourceOf(key) === 'NL-2') {
          const found = discover(parseCollection(body)).series.find((s) => s.key === series);
          expect([fixture, found !== undefined]).toEqual([fixture, true]);
          latest = [Date.parse((found as { ts: string }).ts)];
        }
        expect([fixture, latest.length]).toEqual([fixture, 1]);
        const at = latest[0] as number;
        expect([fixture, iso(at), at <= fetchedAt, at >= fetchedAt - 70 * MIN]).toEqual([fixture, iso(at), true, true]);
        instants.push(latest);
      }
      if (snapshots === true) {
        // Never back: a label put on the wrong pass of the repeated hour is an hour off.
        const all = instants.flat().map(iso);
        expect(all).toEqual(all.toSorted());
        return;
      }
      const grid = Array.from({ length: (TO - FROM) / (stepMin * MIN) }, (_, i) => iso(FROM + i * stepMin * MIN));
      for (const [i, ts] of instants.entries()) {
        const got = ts.map(iso);
        // Each payload: on the grid, and each instant once.
        expect([fixtures[i], got.filter((t) => !grid.includes(t)), got.length - new Set(got).size]).toEqual([
          fixtures[i],
          [],
          0,
        ]);
      }
      // All payloads together: the whole grid, none missing.
      expect([...new Set(instants.flat())].sort((a, b) => a - b).map(iso)).toEqual(grid);
    });
  }

  it.skipIf(PENDING.includes('LU-1') || PENDING.includes('DE-1'))(
    'LU-1: the repeated labels resolve by column order, and the label offset is 0 (LU-1 Perl against DE-1 Perl)',
    async () => {
      const perl = async (key: 'LU-1' | 'DE-1', series: string) =>
        [...obsParts((await load(key, (SET[key] as Entry).fixtures[0] as string)).out)]
          .flat()
          .filter((r) => r.series === series)
          .map((r) => ({ ts: Date.parse(r.ts), value: r.value }));
      const lu = await perl('LU-1', OFFSET_PAIR.key);
      const de = await perl('DE-1', OFFSET_PAIR.against.key);
      // Column order: the file's instants rise, through both passes of 02:00–02:45 (+02:00, then +01:00).
      const ts = lu.map((p) => p.ts);
      expect(ts).toEqual(ts.toSorted((a, b) => a - b));
      expect(new Set(ts).size).toBe(ts.length);
      // Loaded with no measured offset (the detector has measured 0 since AGE's format change of 2026-09-30), LU-1
      // Perl equals DE-1 Perl, whose timestamps carry their offset, at every DE-1 instant of the night at shift 0,
      // and trails it at ±15 min by more than the detector's margin. (The detector itself decides a whole UTC day:
      // in this six-hour window DE-1 moves on both sides of only 4 instants, fewer than MIN_ALIGNED, so on its own
      // the window would decide nothing.) The tolerance is the detector's, 0.05 cm.
      const scores = scoreShifts(lu, de, OFFSET_SHIFTS, { tolerance: 0.05 });
      expect(scores.find((s) => s.shift === 0)).toMatchObject({ n: de.length, share: 1 });
      for (const s of scores.filter((x) => x.shift !== 0))
        expect([s.shift, s.share <= 1 - MARGIN]).toEqual([s.shift, true]);
    },
  );
});
