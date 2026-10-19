import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validateWaterbodies } from '../packages/contracts/src/waterbodies.ts';

// registry/waterbodies.yaml (P17b): the committed file is valid, every rivers.yaml mouth names a body, no body has a
// reference gauge yet (D-2) and every NL-1 spelling is a water_name the NL-1 registry really publishes.

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

  it('has no reference station (D-2)', () => {
    for (const w of file.waterbodies) expect(w.reference_station, w.id).toBeNull();
  });

  it('uses only water_name spellings that NL-1 publishes', () => {
    const published = new Set<string>(
      read('stations/nl-1.yaml').stations.map((s: { water_name: string | null }) => s.water_name),
    );
    for (const w of file.waterbodies)
      for (const n of w.names['NL-1'] ?? []) expect(published.has(n), `${w.id} ${n}`).toBe(true);
  });
});
