import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { H_DESCRIPTION } from '../apps/server/src/adapters/nl-4/normalise.ts';
import { readThresholds } from '../apps/server/src/load/thresholds.ts';
import { validateWaterbodies } from '../packages/contracts/src/waterbodies.ts';

// registry/waterbodies.yaml (P17b): the committed file is valid, every rivers.yaml mouth names a body, no body has a
// reference gauge only where the owner chose one (D27, O-3 of 2026-10-22) and every NL-1 spelling is a water_name the NL-1 registry really publishes.

const read = (p: string) => parse(readFileSync(new URL(`../registry/${p}`, import.meta.url), 'utf8'));
const rivers = read('rivers.yaml');
const file = read('waterbodies.yaml');

describe('registry/waterbodies.yaml', () => {
  it('validates with the rivers.yaml mouths', () => {
    expect(validateWaterbodies(file, rivers).problems).toEqual([]);
  });

  it('holds a body for every mouth', () => {
    const ids = new Set(file.waterbodies.map((w: { id: string }) => w.id));
    expect(rivers.mouths.length).toBeGreaterThan(0);
    for (const m of rivers.mouths) expect(ids.has(m.waterbody), m.id).toBe(true);
  });

  // The owner's map (O-3, 2026-10-22): the D27 reference gauge of each lake. The other bodies have none: four lakes
  // without a gauge of their own, and the sea and estuary bodies, which have no single level.
  const REFERENCE: Record<string, string> = {
    ijsselmeer: 'nl.rws.krabbersgat.ijsselmeer',
    markermeer: 'nl.rws.markermeer.midden',
    ketelmeer: 'nl.rws.ketelhaven.ketelmeer',
    'veerse-meer': 'nl.rws.kamperland.schotsman',
    volkerak: 'nl.rws.willemstad.volkerak',
    grevelingenmeer: 'nl.rws.bommenede',
    eemmeer: 'nl.rws.eemdijk',
    gooimeer: 'nl.rws.almere.hollandsebrug',
    ijmeer: 'nl.rws.amsterdam.schellingwouderbrug',
    'zwarte-meer': 'nl.rws.kadoelen.zwanediep',
    nijkerkernauw: 'nl.rws.nijkerk.nijkerkernauw',
    nuldernauw: 'nl.rws.nijkerk.nuldernauw',
    drontermeer: 'nl.rws.dronten.reevesluis.drontermeer',
    haringvliet: 'nl.rws.hellevoetsluis',
  };
  const NONE = ['veluwemeer', 'wolderwijd', 'vossemeer', 'zoommeer'];
  /** The owner exception: the reference is the only gauge of the Drontermeer, and the workbook has no class for it. */
  const NO_CLASSES = ['drontermeer'];

  it('names the reference gauge of exactly the 14 bodies the owner chose (D27, O-3)', () => {
    const got = Object.fromEntries(
      file.waterbodies
        .filter((w: { reference_station: string | null }) => w.reference_station !== null)
        .map((w: { id: string; reference_station: string }) => [w.id, w.reference_station]),
    );
    expect(got).toEqual(REFERENCE);
    expect(Object.keys(REFERENCE)).toHaveLength(14);
    const without = file.waterbodies
      .filter((w: { reference_station: string | null }) => w.reference_station === null)
      .map((w: { id: string }) => w.id);
    expect(without.sort()).toEqual(
      [...NONE, 'noordzee', 'waddenzee', 'oosterschelde', 'westerschelde', 'eems-dollard'].sort(),
    );
    // the sea and estuary bodies never get one
    for (const w of file.waterbodies)
      if (w.kind === 'sea' || w.kind === 'estuary') expect(w.reference_station, w.id).toBeNull();
  });

  // Whether the reference is among the body's placed stations is checked on the real polygons in
  // waterbody-snap.test.ts; here it is a public primary NL-1 level station on NAP, with NL-4 classes.
  it('each reference is a public primary NL-1 H station on NAP with NL-4 rows, bar the Drontermeer exception', () => {
    const stations: {
      id: string;
      quantity: string;
      role: string;
      audience: string;
      provider_code: string;
      datum?: string;
    }[] = read('stations/nl-1.yaml').stations;
    const classes = new Set(
      readThresholds(readFileSync(new URL('../registry/thresholds/nl-4.csv', import.meta.url), 'utf8'))
        .rows.filter((r) => r.description === H_DESCRIPTION)
        .map((r) => r.code),
    );
    for (const w of file.waterbodies) {
      if (w.reference_station === null) continue;
      const rows = stations.filter((s) => s.id === w.reference_station && s.quantity === 'H' && s.role === 'primary');
      expect(rows, `${w.id}: ${w.reference_station}`).toHaveLength(1);
      const s = rows[0] as (typeof stations)[number];
      expect([s.quantity, s.role, s.audience, s.datum], w.id).toEqual(['H', 'primary', 'public', 'NAP']);
      expect(classes.has(s.provider_code), `${w.id}: NL-4 rows of ${s.provider_code}`).toBe(!NO_CLASSES.includes(w.id));
    }
  });

  it('uses only water_name spellings that NL-1 publishes', () => {
    const published = new Set<string>(
      read('stations/nl-1.yaml').stations.map((s: { water_name: string | null }) => s.water_name),
    );
    for (const w of file.waterbodies)
      for (const n of w.names['NL-1'] ?? []) expect(published.has(n), `${w.id} ${n}`).toBe(true);
  });
});
