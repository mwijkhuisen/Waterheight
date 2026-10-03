import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { sectionMap, vigicruesSectionCodes, vigicruesSections } from '../apps/server/src/load/tables.ts';
import { VigicruesOverridesFile, VigicruesSectionsFile } from '../packages/contracts/src/tables.ts';
import { build, CSV, extract, FR1, NO_SECTION_WATER, OUTPUT } from '../scripts/gen-fr5-sections.ts';

// registry/vigicrues-sections.yaml is generated (scripts/gen-fr5-sections.ts) from registry/seed/fr-5-sections.csv
// (the TronEntVigiCru documents of the production archive) and registry/stations/fr-1.yaml: the committed file is
// exactly the generator's output, each Vigicrues station is in one section, and our FR-1 stations on the French
// Escaut, Scarpe and Deûle are in none.

const committed = readFileSync(OUTPUT, 'utf8');
const csv = readFileSync(CSV, 'utf8');
const fr1Text = readFileSync(FR1, 'utf8');
const file = VigicruesSectionsFile.parse(parse(committed));
type Fr1 = {
  id: string;
  provider_code: string;
  water_name: string | null;
  role: string;
  audience: string;
  quantity: string;
};
const fr1 = (parse(fr1Text) as { stations: Fr1[] }).stations;
const publicH = fr1.filter((r) => r.role === 'primary' && r.quantity === 'H' && r.audience === 'public');

describe('registry/vigicrues-sections.yaml', () => {
  it('is exactly the generator output (byte for byte)', () => {
    expect(build(csv, fr1Text)).toBe(committed);
  });

  it('holds the 56 sections of the territories 2, 3 and 29, each Vigicrues station in exactly one', () => {
    expect(file.sections).toHaveLength(56);
    expect(new Set(file.sections.map((s) => s.territory))).toEqual(new Set(['2', '3', '29']));
    const stations = file.sections.flatMap((s) => s.stations.map((m) => m.vigicrues));
    expect(stations.length).toBe(new Set(stations).size);
    expect(stations).toHaveLength(331);
    // The sections are sorted, so a regeneration has a stable diff.
    expect(file.sections.map((s) => s.section)).toEqual([...file.sections.map((s) => s.section)].sort());
  });

  it('every FR-1 station of the table is a public primary stage series of that Sandre code, in one section only', () => {
    const byCode = new Map(publicH.map((r) => [r.provider_code, r.id]));
    const ids = file.sections.flatMap((s) => s.stations.flatMap((m) => (m.station === null ? [] : [m.station])));
    expect(ids.length).toBe(new Set(ids).size);
    expect(ids).toHaveLength(233);
    for (const s of file.sections)
      for (const m of s.stations)
        expect([m.vigicrues, m.station]).toEqual([m.vigicrues, byCode.get(m.vigicrues) ?? null]);
    // Every FR-1 station that a section links is also found by the loader's own table.
    expect(vigicruesSections().size).toBe(ids.length);
  });

  it('the French Escaut, Scarpe and Deûle stations (11) have no section', () => {
    const expected = publicH
      .filter((r) => NO_SECTION_WATER.test(r.water_name ?? ''))
      .map((r) => r.id)
      .sort();
    expect(expected).toHaveLength(11);
    expect(file.none).toEqual(expected);
    const linked = new Set(file.sections.flatMap((s) => s.stations.map((m) => m.station)));
    for (const id of file.none) {
      expect([id, linked.has(id)]).toEqual([id, false]);
      expect([id, vigicruesSections().has(id)]).toEqual([id, false]);
    }
    // The water names that the rule catches (a Moselle must not).
    expect(new Set(publicH.filter((r) => file.none.includes(r.id)).map((r) => r.water_name))).toEqual(
      new Set(["L'Escaut Canalisée", 'Selle ou Escaut', 'Rivière Scarpe', 'La Scarpe Canalisée', 'Canal de la Deule']),
    );
  });

  it('every tier-1 French station that Vigicrues covers is in a section (Meuse, Moselle, Rhine tributaries)', () => {
    const linked = new Set(file.sections.flatMap((s) => s.stations.map((m) => m.station)));
    for (const code of ['B540001001', 'B315002001', 'B720000001', 'A850061001', 'A443064001']) {
      const id = publicH.find((r) => r.provider_code === code)?.id;
      expect([code, id !== undefined && linked.has(id)]).toEqual([code, true]);
    }
  });

  it('the loader reads the table: LO18 (Meuse frontalière - Semoy) holds Chooz', () => {
    expect(vigicruesSections().get('fr.sandre.B720000001')).toBe('LO18');
    expect(vigicruesSectionCodes().size).toBe(56);
    expect(vigicruesSectionCodes().has('AP1')).toBe(true);
  });
});

describe('the generator', () => {
  it('fails on a station in two sections and on an Escaut station in a section', () => {
    expect(() => build(`${csv}ZZ1,2,B720000001\n`, fr1Text)).toThrow(/two sections/);
    const escaut = publicH.find((r) => /Escaut/.test(r.water_name ?? ''))?.provider_code as string;
    expect(() => build(`${csv}ZZ1,2,${escaut}\n`, fr1Text)).toThrow(/Escaut, Scarpe or Deûle/);
    expect(() => build(csv.replace('section,territory,station', 'a,b,c'), fr1Text)).toThrow(/header/);
  });

  it('--extract fails on a document that is not what it expects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr5-'));
    try {
      expect(() => extract(dir)).toThrow(/territory document of 2 is missing/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('registry/vigicrues-overrides.yaml', () => {
  it('is a valid, empty file (a reviewed correction is an entry)', () => {
    const overrides = VigicruesOverridesFile.parse(
      parse(readFileSync(new URL('../registry/vigicrues-overrides.yaml', import.meta.url), 'utf8')),
    );
    expect(overrides).toEqual({ overrides: [] });
  });

  it('an override moves a station to another section or to none (applied by the loader, here with a temporary directory)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr5-registry-'));
    try {
      const base = {
        sections: [
          {
            section: 'AA1',
            territory: '2',
            stations: [
              { vigicrues: 'B111111111', station: 'fr.sandre.B111111111' },
              { vigicrues: 'B222222222', station: 'fr.sandre.B222222222' },
              { vigicrues: 'B333333333', station: null },
            ],
          },
          { section: 'BB2', territory: '3', stations: [{ vigicrues: 'B444444444', station: 'fr.sandre.B444444444' }] },
        ],
        none: [],
      };
      const url = pathToFileURL(`${dir}/`);
      writeFileSync(join(dir, 'vigicrues-sections.yaml'), JSON.stringify(base));
      // Without an overrides file: the table as it is.
      expect([...sectionMap(url)]).toEqual([
        ['fr.sandre.B111111111', 'AA1'],
        ['fr.sandre.B222222222', 'AA1'],
        ['fr.sandre.B444444444', 'BB2'],
      ]);
      writeFileSync(
        join(dir, 'vigicrues-overrides.yaml'),
        JSON.stringify({
          overrides: [
            { vigicrues: 'B111111111', section: 'BB2', reason: 'moved to the neighbouring section' },
            { vigicrues: 'B222222222', section: null, reason: 'no section level reaches it' },
          ],
        }),
      );
      expect([...sectionMap(url)]).toEqual([
        ['fr.sandre.B111111111', 'BB2'],
        ['fr.sandre.B444444444', 'BB2'],
      ]);
      // An invalid file is refused, not half applied.
      writeFileSync(
        join(dir, 'vigicrues-overrides.yaml'),
        JSON.stringify({ overrides: [{ vigicrues: 'x', section: 'AA1', reason: 'r' }] }),
      );
      expect(() => sectionMap(url)).toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
