import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type Case,
  chCase,
  classified,
  de1Case,
  de7Case,
  frCase,
  lu1Case,
  napOf,
  nl1Case,
  nl1WfsCase,
  vigilance,
} from './inputs.ts';

// Golden states of about 30 real public stations (PHASES P7b): the rows are produced by the real adapters from the
// committed real fixtures (DE-1, DE-6, DE-7, NL-1 with NL-4, CH-1 with CH-2, FR-1 with FR-5, LU-1) and go through the
// pure classifier as the public family, `fresh: true` everywhere (the golden is about the mapping, not about capture
// health) and t = the value's own timestamp. The recordings are of 2026-09-29/30, a low-water period: states are low,
// normal or no_ref; the flood levels are in flood.test.ts. `UPDATE_GOLDEN=1` rewrites the golden file; a change of it
// is reviewed like code.

const GOLDEN = new URL('./golden-states.golden.json', import.meta.url);
const FR5 = vigilance('fr-5-vigilance');

type Spec = { why: string; build: () => Case | Promise<Case> };
const SPECS: Spec[] = [
  // DE-1 on the Rhine: MNW/MHW/HSW of the meta payload plus the LHP station class.
  { why: 'Kaub: 1 cm under MNW 65 is low, LHP RP:0 says only "not elevated"', build: () => de1Case('de.wsv.25700100') },
  { why: 'Maxau W: MNW 353 with HSW and MHW, LHP BY/RP class 0', build: () => de1Case('de.wsv.23700200') },
  {
    why: 'Maxau Q: a discharge series takes no stage reference or class: no_ref',
    build: () => de1Case('de.wsv.23700200', 'Q'),
  },
  { why: 'Köln: Lower Rhine gauge, NW class 0, below MNW 114', build: () => de1Case('de.wsv.2730010') },
  { why: 'Düsseldorf: a negative stage (-8 cm) under MNW 70', build: () => de1Case('de.wsv.2750010') },
  {
    why: 'Duisburg-Ruhrort: highest HSW (1130 cm) of the set, value under MNW 201',
    build: () => de1Case('de.wsv.2770010'),
  },
  { why: 'Emmerich: German-Dutch border gauge, -28 cm under MNW 51', build: () => de1Case('de.wsv.2790020') },
  {
    why: 'Trier UP: Moselle gauge 1 cm above MNW 219: normal, basis LHP RP:0',
    build: () => de1Case('de.wsv.26500100'),
  },
  {
    why: 'Frankfurt Osthafen: stage equal to MNW (154): the low bound is inclusive',
    build: () => de1Case('de.wsv.24700404'),
  },
  {
    why: 'Raunheim: 5 cm above MNW 118 on the Main: normal between MNW and MHW',
    build: () => de1Case('de.wsv.24900108'),
  },
  {
    why: 'Grevenmacher UP: only an HSW is published: nothing decides below it, no_ref',
    build: () => de1Case('de.wsv.26100200'),
  },
  {
    why: 'Papenburg: a tidal Ems gauge with no reference and no class: no_ref, flag tidal',
    build: () => de1Case('de.wsv.3790010'),
  },
  // DE-7 (NRW): LANUV levels of the pegeldaten blocks.
  {
    why: 'Gronau: LANUV MNW, MW, MHW and Info 1-3: between MNW and Info 1 is normal',
    build: () => de7Case('de.lanuk.9286455000200'),
  },
  {
    why: 'Goch: Info levels 185/200/230 and a value under MNW 31: the statistic overrides the scale',
    build: () => de7Case('de.lanuk.2869500000200'),
  },
  { why: 'Stah: Info levels 200/245/265, value under MNW 31', build: () => de7Case('de.lanuk.2829100000100') },
  {
    why: 'Pannenmuehle: no Info levels, only MNW/MW/MHW: above MNW nothing decides, no_ref',
    build: () => de7Case('de.lanuk.2847500000100'),
  },
  // NL-1 with the NL-4 Waterinfo classes.
  {
    why: 'Lobith H: NL-4 display class of the Rhine at the Dutch border',
    build: () => nl1Case('nl.rws.lobith.bovenrijn.tolkamer'),
  },
  { why: 'Lobith Q: NL-4 discharge classes', build: () => nl1Case('nl.rws.lobith.bovenrijn.tolkamer', 'Q') },
  {
    why: 'Eijsden grens H: a Maas level in m NAP (4407 cm) with NL-4 classes',
    build: () => nl1Case('nl.rws.eijsden.grens'),
  },
  {
    why: 'Delfzijl: a tidal NL-1 station: NL-4 classes are provider classes, D12 leaves them out: no_ref',
    build: () => nl1WfsCase('nl.rws.delfzijl'),
  },
  // CH-1 with the CH-2 thresholds.
  { why: 'Brugg Q: river, BAFU danger 1 and WL2 820: normal', build: () => chCase('ch.bafu.2016', 'Q') },
  {
    why: 'Brugg H: the class goes to the Q series only, a level with no WL threshold is no_ref',
    build: () => chCase('ch.bafu.2016', 'H'),
  },
  {
    why: 'Rheinfelden Q: the first tier-1 Rhine station below the Rhine falls, WL2 2500',
    build: () => chCase('ch.bafu.2091', 'Q'),
  },
  { why: 'Basel Rheinhalle Q: BAFU gauge that DE-1 mirrors', build: () => chCase('ch.bafu.2289', 'Q') },
  {
    why: 'Murten: a lake station, its H series takes the class and the WL thresholds',
    build: () => chCase('ch.bafu.2004', 'H'),
  },
  { why: 'Zug: a lake with a level threshold set, below WL2', build: () => chCase('ch.bafu.2017', 'H') },
  {
    why: 'Le Pont: a lake with dangerLevel undefined (cube.link/Undefined): no_ref',
    build: () => chCase('ch.bafu.2007', 'H'),
  },
  {
    why: 'Basel LHG: a river H-only station with dangerLevel undefined: no_ref',
    build: () => chCase('ch.bafu.2615', 'H'),
  },
  // FR-1 with the FR-5 section of the station.
  {
    why: 'Lauterbourg H: section SA16, vigilance level 1: normal through the section',
    build: () => frCase('fr.sandre.A302009050', 'H', FR5),
  },
  {
    why: 'Lauterbourg Q: the section applies to every series without a gauge state',
    build: () => frCase('fr.sandre.A302009050', 'Q', FR5),
  },
  {
    why: 'Uckange H: Moselle section LO10, French gauge zero (unverified, no NAP)',
    build: () => frCase('fr.sandre.A850061001', 'H', FR5),
  },
  {
    why: "Torgny H: a Belgian §0.6 partner of Hub'Eau (La Chiers en Belgique) in section LO19",
    build: () => frCase('fr.sandre.B422431101', 'H', FR5),
  },
  {
    why: 'Iwuy H: the canalised Escaut is in no Vigicrues section: no_ref',
    build: () => frCase('fr.sandre.E131000202', 'H', FR5),
  },
  // LU-1: no public reference, class or zone at the recording time.
  { why: 'Diekirch: a Sûre/Alzette gauge with no public reference: no_ref', build: () => lu1Case('lu.age.diekirch') },
  {
    why: 'Wasserbillig: an impounded Sûre stage on the Moselle, no reference',
    build: () => lu1Case('lu.age.wasserbillig'),
  },
  {
    why: 'Mersch: the Alzette, inside the zone Sud but no LU-Alert zone was active on 2026-09-29',
    build: () => lu1Case('lu.age.mersch'),
  },
];

const entries = await Promise.all(
  SPECS.map(async (s) => {
    const c = await s.build();
    const out = classified(c);
    return {
      why: s.why,
      entry: {
        station: c.row.id,
        series: c.row.quantity,
        source: c.row.source,
        t: c.obs.ts,
        value: c.obs.value,
        state: out.state,
        basis: out.basis,
        section: out.section,
        area: out.area,
        flags: out.flags,
        nap: napOf(c),
      },
    };
  }),
);
const key = (e: { station: string; series: string }) => `${e.station}#${e.series}`;
const actual = Object.fromEntries(entries.map((e) => [key(e.entry), e.entry]));

function golden(): typeof actual {
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(GOLDEN)) throw new Error('no golden-states.golden.json: run with UPDATE_GOLDEN=1 and review it');
  return JSON.parse(readFileSync(GOLDEN, 'utf8'));
}

describe('golden states of real public stations', () => {
  const want = golden();

  it('the set is about 30 distinct station series across every public provider', () => {
    expect(entries.length).toBeGreaterThanOrEqual(30);
    expect(new Set(entries.map((e) => key(e.entry))).size).toBe(entries.length);
    expect(new Set(entries.map((e) => e.entry.source))).toEqual(
      new Set(['DE-1', 'DE-7', 'NL-1', 'CH-1', 'FR-1', 'LU-1']),
    );
    expect(Object.keys(want)).toEqual(Object.keys(actual));
  });

  it.each(entries.map((e) => [key(e.entry), e.why, e.entry] as const))('%s: %s', (k, _why, entry) => {
    expect(entry).toEqual(want[k]);
  });

  it("every value is the recording's own and no basis names an owner source", () => {
    for (const { entry } of entries) {
      expect(Number.isFinite(entry.value)).toBe(true);
      expect(['LU-4', 'BE-3']).not.toContain(entry.basis?.source);
      // basis is null exactly when there is no state
      expect(entry.basis === null).toBe(entry.state === 'no_ref');
    }
  });

  it('the headline cases', () => {
    const at = (k: string) => actual[k];
    expect(at('de.wsv.25700100#H')).toMatchObject({ state: 'low', basis: { label: 'WSV MNW 2010–2020' } });
    expect(at('de.wsv.24700404#H')).toMatchObject({ state: 'low' });
    expect(at('de.wsv.26500100#H')).toMatchObject({ state: 'normal', basis: { source: 'DE-6', ref: 'RP:0' } });
    expect(at('de.wsv.3790010#H')).toMatchObject({ state: 'no_ref', flags: { tidal: true } });
    expect(at('fr.sandre.A302009050#H')).toMatchObject({ state: 'normal', section: true });
    expect(at('fr.sandre.E131000202#H')).toMatchObject({ state: 'no_ref', section: false });
  });
});
