import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { reachOf } from '../apps/server/src/api/forecast.ts';
import { ForecastReaches, SourcesFile, StationsFile } from '../packages/contracts/src/index.ts';
import { repoRoot, strip } from './catalogue.ts';

// registry/forecast-reaches.yaml (P8a): pinned to the 15 rows of catalogue §0.5 one by one (names, the sources of the
// "First release" column and of the owner view, the agencies of "After a permission" and "Not available"), to the
// river ids of registry/rivers.yaml and the sources of registry/sources.yaml, and the first-release stations it takes
// (each by one row at most; the ones no row takes are pinned as `other`).

const registry = (path: string) => readFileSync(`${repoRoot}registry/${path}`, 'utf8');
const yaml = (path: string) => parse(registry(path));
// Read the way the server reads it: aliases off (the file has none).
const file = ForecastReaches.parse(parse(registry('forecast-reaches.yaml'), { maxAliasCount: 0 }));
const rows = file.reaches;

// The catalogue's §0.5 table: River / reach | First release | After a permission | Not available.
const catalogue = readFileSync(`${repoRoot}docs/sources/SOURCE-CATALOGUE.md`, 'utf8');
const section05 = (() => {
  const start = catalogue.indexOf('### 0.5 Forecast coverage per river');
  const end = catalogue.indexOf('### 0.6', start);
  if (start < 0 || end < 0) throw new Error('catalogue §0.5 not found');
  return catalogue.slice(start, end);
})();
const table = section05
  .split('\n')
  .filter((l) => l.startsWith('| ') && !l.startsWith('| River'))
  .map((l) =>
    l
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim()),
  );
const OWNER_VIEW = section05.slice(section05.indexOf('**Owner view'), section05.indexOf('**EFAS and GloFAS'));

const IDS = [
  'swiss-rhine-aare',
  'upper-rhine',
  'rhine-maxau-emmerich',
  'dutch-rhine-branches',
  'mosel-fr',
  'mosel-lu-de',
  'sauer-our',
  'saar',
  'nahe-ahr-lahn-sieg',
  'main-neckar',
  'meuse-fr',
  'meuse-wallonia',
  'grensmaas-dutch-meuse',
  'scheldt-leie-dender',
  'ems-vecht',
];

/** The agencies a cell names, by the word the catalogue uses for them (LU-3 is AGE's forecast). */
const AFTER: [string, RegExp][] = [
  ['LfU RLP', /\bRLP\b/],
  ['LUBW', /\bLUBW\b/],
  ['HLNUG', /\bHLNUG\b/],
  ['HIC', /\bHIC\b/],
  ['VMM', /\bVMM\b/],
  ['AGE', /\bAGE\b|\bLU-3\b/],
];
const NOT_AVAILABLE: [string, RegExp][] = [
  ['Saarland', /\bSaarland\b/],
  ['Bavarian HND', /\bBavarian HND\b/],
  ['SPW', /\bSPW\b/],
  ['NLWKN', /\bNLWKN\b/],
];
const named = (cell: string, agencies: [string, RegExp][]) =>
  agencies.filter(([, re]) => re.test(cell)).map(([name]) => name);
const sourceIds = (cell: string) => [...new Set(cell.match(/\b(?:NL|DE|BE|FR|LU|CH)-\d+\b/g) ?? [])];
/** The sources the owner view adds, per row (§0.5: "LU-3 fills the Sauer/Sûre and Our rows", "DE-3 adds … Maxau → Emmerich"). */
const OWNER_ADDS: Record<string, string[]> = { 'rhine-maxau-emmerich': ['DE-3'], 'sauer-our': ['LU-3'] };

describe('registry/forecast-reaches.yaml and catalogue §0.5', () => {
  it('has the 15 rows of the table, in its order, with the catalogue’s own names', () => {
    expect(table).toHaveLength(15);
    expect(rows.map((r) => r.id)).toEqual(IDS);
    expect(rows.map((r) => r.names.en)).toEqual(table.map((c) => strip(c[0] ?? '')));
  });

  it('every row has a Dutch name and no stations override', () => {
    for (const r of rows) {
      expect(r.names.nl.length, r.id).toBeGreaterThan(1);
      expect(Object.keys(r).sort(), r.id).toEqual([
        'after_permission',
        'id',
        'match',
        'names',
        'none_publishes',
        'sources',
      ]);
    }
  });

  it('sources are the "First release" column plus what the owner view of §0.5 adds, nothing else', () => {
    expect(OWNER_VIEW).toContain('LU-3 fills the Sauer/Sûre and Our rows');
    expect(OWNER_VIEW).toContain('DE-3 adds the BfG 14-day and 6-week forecasts to the Rhine Maxau → Emmerich row');
    rows.forEach((r, i) => {
      const first = sourceIds(table[i]?.[1] ?? '');
      expect([...r.sources].sort(), r.id).toEqual([...first, ...(OWNER_ADDS[r.id] ?? [])].sort());
    });
    expect(rows.flatMap((r) => r.sources.map((s) => `${r.id} ${s}`))).toEqual([
      'swiss-rhine-aare CH-4',
      'rhine-maxau-emmerich DE-2',
      'rhine-maxau-emmerich DE-3',
      'dutch-rhine-branches NL-1',
      'mosel-fr FR-4',
      'sauer-our LU-3',
      'saar FR-4',
      'meuse-fr FR-4',
      'grensmaas-dutch-meuse NL-1',
      'scheldt-leie-dender NL-1',
      'ems-vecht NL-1',
    ]);
  });

  it('every source is a registered source', () => {
    const known = new Set(SourcesFile.parse(yaml('sources.yaml')).sources.map((s) => s.id));
    for (const r of rows) for (const s of r.sources) expect(known.has(s), `${r.id} ${s}`).toBe(true);
  });

  it('after_permission names the agencies of the "After a permission" column, none_publishes those of "Not available"', () => {
    rows.forEach((r, i) => {
      expect([...r.after_permission].sort(), `${r.id} after`).toEqual(named(table[i]?.[2] ?? '', AFTER).sort());
      expect([...r.none_publishes].sort(), `${r.id} none`).toEqual(named(table[i]?.[3] ?? '', NOT_AVAILABLE).sort());
    });
    // The Dutch Rhine branches' "longer RWS fan forecasts" are a product, not an agency that publishes none.
    expect(table[3]?.[3]).toContain('Longer RWS fan forecasts');
    expect(rows[3]?.none_publishes).toEqual([]);
  });

  it('the public text names no owner agency or source: no BfG, DE-2 or DE-3 in an agency list or a name', () => {
    for (const r of rows) {
      const text = JSON.stringify([r.names, r.after_permission, r.none_publishes]);
      expect(text, r.id).not.toMatch(/BfG|DE-2|DE-3|LU-3|LU-4|LU-2|BE-3|CANARY/);
    }
  });

  it('every river of a match is a river of registry/rivers.yaml, and every match bounds by km only with rivers', () => {
    const rivers = new Set((yaml('rivers.yaml') as { rivers: { id: string }[] }).rivers.map((r) => r.id));
    for (const r of rows)
      for (const m of r.match) {
        for (const id of m.rivers ?? []) expect(rivers.has(id), `${r.id} ${id}`).toBe(true);
        if (m.km_min !== undefined || m.km_max !== undefined) expect(m.rivers, r.id).toBeDefined();
      }
  });

  it('splits the Rhine at Maxau (km 362.3): Basel to Maxau below it, Maxau to Emmerich from it, no gap and no overlap', () => {
    const upper = rows.find((r) => r.id === 'upper-rhine')?.match.find((m) => m.countries?.includes('DE'));
    const middle = rows.find((r) => r.id === 'rhine-maxau-emmerich')?.match[0];
    expect(upper?.km_max).toBe(362.3);
    expect(middle?.km_min).toBe(362.3);
    const of = (km: number | null, country = 'DE') => reachOf(rows, { country, river: 'rhine', km });
    const id = (km: number | null, country = 'DE') => rows[of(km, country)]?.id;
    expect(id(362.299)).toBe('upper-rhine');
    expect(id(362.3)).toBe('rhine-maxau-emmerich');
    expect(id(362.327)).toBe('rhine-maxau-emmerich');
    expect(id(851.9)).toBe('rhine-maxau-emmerich');
    expect(id(null)).toBeUndefined();
    // The French Rhine goes to Basel → Maxau whatever its km, the Swiss one to the Swiss row, the Dutch one to the branches.
    expect(id(null, 'FR')).toBe('upper-rhine');
    expect(id(147.35, 'CH')).toBe('swiss-rhine-aare');
    expect(id(862, 'NL')).toBe('dutch-rhine-branches');
  });
});

describe('the first-release stations and the reach rows', () => {
  type Placed = { id: string; river: string | null; km_official: number | null };
  const placed = new Map((yaml('rivernet.yaml') as { stations: Placed[] }).stations.map((s) => [s.id, s]));
  const stations = new Map<string, { id: string; country: string }>();
  for (const f of readdirSync(`${repoRoot}registry/stations`)) {
    for (const s of StationsFile.parse(yaml(`stations/${f}`)).stations)
      if (s.audience === 'public' && s.role === 'primary' && s.tier === 1)
        stations.set(s.id, { id: s.id, country: s.country });
  }
  const at = (id: string, country: string) => {
    const p = placed.get(id);
    return { country, river: p?.river ?? null, km: p?.km_official ?? null };
  };
  const byRow = new Map<string, string[]>();
  for (const st of [...stations.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const i = reachOf(rows, at(st.id, st.country));
    const key = i < 0 ? 'other' : (rows[i]?.id as string);
    byRow.set(key, [...(byRow.get(key) ?? []), st.id]);
  }

  it('there are 148 first-release stations (tier 1 with a public primary series)', () => {
    expect(stations.size).toBe(148);
  });

  it('no station is taken by two rows: the rows are disjoint', () => {
    const doubled = [...stations.values()].filter(
      (st) => rows.filter((r) => reachOf([r], at(st.id, st.country)) === 0).length > 1,
    );
    expect(doubled.map((s) => s.id)).toEqual([]);
  });

  it('each row takes this many first-release stations (a change of the matrix or the placement shows here)', () => {
    expect(Object.fromEntries(rows.map((r) => [r.id, byRow.get(r.id)?.length ?? 0]))).toEqual({
      'swiss-rhine-aare': 17,
      'upper-rhine': 5,
      'rhine-maxau-emmerich': 17,
      'dutch-rhine-branches': 18,
      'mosel-fr': 6,
      'mosel-lu-de': 9,
      'sauer-our': 6,
      saar: 5,
      'nahe-ahr-lahn-sieg': 2,
      'main-neckar': 8,
      'meuse-fr': 6,
      'meuse-wallonia': 0,
      'grensmaas-dutch-meuse': 9,
      'scheldt-leie-dender': 8,
      'ems-vecht': 5,
    });
  });

  it('pins the stations that match no row: tributaries and waters the catalogue table does not name', () => {
    expect(byRow.get('other')).toEqual([
      'de.lanuk.2829100000100', // Rur
      'de.lanuk.2849900000100', // Schwalm
      'de.lanuk.2869500000200', // Niers
      'de.lanuk.9281700000200', // Oude IJssel
      'de.lanuk.9282570000100', // Bocholter Aa (no graph river)
      'de.lanuk.9284730000100', // Berkel
      'de.lanuk.9286455000200', // Dinkel
      'de.wsv.27600090', // Ruhr
      'fr.sandre.A228003001', // Ill
      'fr.sandre.A692101001', // Meurthe
      'fr.sandre.B402101001', // Chiers (FR)
      'fr.sandre.B403101001',
      'fr.sandre.B422431101', // Chiers (BE)
      'fr.sandre.B460101001',
      'fr.sandre.B463101001',
      'fr.sandre.B466010101',
      'fr.sandre.B611101001', // Semois
      'fr.sandre.D016221001', // Sambre
      'fr.sandre.D019223001',
      'fr.sandre.D019801101',
      'fr.sandre.E201000501', // Scarpe (unsnapped)
      'fr.sandre.E207111003',
      'fr.sandre.E223000101',
      'fr.sandre.E237110501',
      'lu.age.clervaux', // unsnapped
      'lu.age.wiltz', // unsnapped
      'nl.rws.epen.geul.cottessen', // Geul
    ]);
  });

  it('the stations DE-2 and LU-3 forecast sit in the rows that list those sources', () => {
    const rowOf = (id: string, country: string) => rows[reachOf(rows, at(id, country))]?.id;
    // The seven DE-2 gauges (registry/seed/de-2.csv): Oestrich … Emmerich, all on the Rhine Maxau → Emmerich row.
    for (const id of ['25100300', '25700100', '25900700', '2730010', '2750010', '2770010', '2790020'])
      expect(rowOf(`de.wsv.${id}`, 'DE'), id).toBe('rhine-maxau-emmerich');
    // The first-release LU-3 slugs: Sauer, Our and Alzette (the LU-3 row), none on the Mosel.
    for (const slug of ['bigonville', 'diekirch', 'ettelbruck-alzette', 'mersch', 'rosport'])
      expect(rowOf(`lu.age.${slug}`, 'LU'), slug).toBe('sauer-our');
    expect(rowOf('lu.age.wasserbillig', 'LU')).toBe('mosel-lu-de');
  });
});
