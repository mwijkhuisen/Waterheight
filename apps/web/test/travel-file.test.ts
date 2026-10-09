import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ReachTravel } from '../src/lib/data/contracts.ts';
import { travelPriorOf, travelText } from '../src/lib/travel.ts';

// Fix #110: every travel time of the committed reaches file in its v2 shape, through the one formatter.

const file = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/reaches-fixture.json', import.meta.url), 'utf8'),
) as { travel_times: Record<string, unknown>[] };

const L = (v: string) => [
  `indicatief: ca. ${v} u (RWS 1985, grote spreiding)`,
  `indicative: about ${v} h (RWS 1985, large spread)`,
];
const J = (v: string) => [`indicatief: ca. ${v} u (piek juli 2021)`, `indicative: about ${v} h (peak July 2021)`];
const R = (lo: number, hi: number) => [`indicatief: ${lo}–${hi} u`, `indicative: ${lo}–${hi} h`];

// [from, to, nl, en] in file order
const GOLDEN: [string, string, ...string[]][] = [
  ['de.wsv.2790020', 'nl.rws.lobith.bovenrijn.tolkamer', ...R(1, 9)],
  ['de.wsv.2770040', 'nl.rws.lobith.bovenrijn.tolkamer', ...R(6, 20)],
  ['de.wsv.2770010', 'nl.rws.lobith.bovenrijn.tolkamer', ...R(13, 27)],
  ['de.wsv.2750010', 'nl.rws.lobith.bovenrijn.tolkamer', ...R(11, 34)],
  ['de.wsv.2730010', 'nl.rws.lobith.bovenrijn.tolkamer', ...R(22, 41)],
  ['de.wsv.2710080', 'nl.rws.lobith.bovenrijn.tolkamer', ...R(24, 49)],
  ['de.wsv.27100400', 'nl.rws.lobith.bovenrijn.tolkamer', ...R(28, 49)],
  [
    'ch.bafu.2289',
    'de.wsv.23700200',
    'indicatief: ca. 23 u (na de Boven-Rijnwerken)',
    'indicative: about 23 h (after the Upper Rhine training works)',
  ],
  [
    'de.wsv.23700200',
    'nl.rws.lobith.bovenrijn.tolkamer',
    'indicatief: 4–5 dagen (afgeleid)',
    'indicative: 4–5 days (derived)',
  ],
  [
    'de.wsv.25700100',
    'nl.rws.lobith.bovenrijn.tolkamer',
    'indicatief: ca. 2 dagen (hoogwater) (afgeleid)',
    'indicative: about 2 days (flood) (derived)',
  ],
  [
    'de.wsv.25900700',
    'nl.rws.lobith.bovenrijn.tolkamer',
    'indicatief: 40–45 u (afgeleid)',
    'indicative: 40–45 h (derived)',
  ],
  ['nl.rws.lobith.bovenrijn.tolkamer', 'nl.rws.nijmegen.waal', ...L('5')],
  ['nl.rws.lobith.bovenrijn.tolkamer', 'nl.rws.tiel.waal', ...L('13')],
  ['nl.rws.lobith.bovenrijn.tolkamer', 'nl.rws.zaltbommel', ...L('19')],
  ['nl.rws.lobith.bovenrijn.tolkamer', 'nl.rws.westervoort.ijsselkop', ...L('5')],
  ['nl.rws.lobith.bovenrijn.tolkamer', 'nl.rws.driel.boven', ...L('12')],
  ['nl.rws.lobith.bovenrijn.tolkamer', 'nl.rws.amerongen.boven', ...L('25')],
  ['nl.rws.lobith.bovenrijn.tolkamer', 'nl.rws.olst', ...L('40')],
  [
    'nl.rws.eijsden.grens',
    'nl.rws.maastricht.sintpieter',
    'indicatief: ca. 1 u (normale omstandigheden)',
    'indicative: about 1 h (normal conditions)',
  ],
  [
    'nl.rws.eijsden.grens',
    'nl.rws.maastricht.borgharen.maas.beneden',
    'indicatief: ca. 3,5 u (piek juli 2021)',
    'indicative: about 3.5 h (peak July 2021)',
  ],
  ['nl.rws.eijsden.grens', 'nl.rws.venlo', ...J('38')],
  ['nl.rws.eijsden.grens', 'nl.rws.megen.maas', ...J('82')],
];

describe('the reaches file travel times, v2 (#110)', () => {
  const parsed = ReachTravel.parse(file).travel_times;

  it('keeps every row of the file', () => {
    expect(parsed).toHaveLength(file.travel_times.length);
    expect(parsed).toHaveLength(GOLDEN.length);
  });

  it.each(GOLDEN.map((g, i) => [`${g[0]} -> ${g[1]}`, i] as const))('%s', (_name, i) => {
    const [from, to, nl, en] = GOLDEN[i] as [string, string, string, string];
    const t = parsed[i];
    expect([t?.from_station_id, t?.to_station_id]).toEqual([from, to]);
    if (t === undefined) return;
    expect(travelText(travelPriorOf(t), 'nl')).toBe(nl);
    expect(travelText(travelPriorOf(t), 'en')).toBe(en);
    expect(nl).toMatch(/^indicatief/);
    expect(en).toMatch(/^indicative/);
  });

  it('drops a row with a bad shape and keeps the good one', () => {
    const good = file.travel_times[0] as Record<string, unknown>;
    const single = file.travel_times.find((t) => typeof t.h === 'number') as Record<string, unknown>;
    const { label: _l, ...noLabel } = single;
    const bad = [
      noLabel, // a single value without its label
      { ...good, d: 2 }, // both h and d
      { ...good, h: [9, 1] }, // lo > hi
      { ...good, h: [5, 5] }, // lo = hi
      { ...good, h: undefined }, // neither
    ];
    const r = ReachTravel.parse({ travel_times: [...bad, good] }).travel_times;
    expect(r).toHaveLength(1);
    expect(r[0]?.h).toEqual([1, 9]);
  });
});
