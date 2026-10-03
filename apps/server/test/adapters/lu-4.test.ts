import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { StationsFile } from '@rws/contracts';
import { type Normalised as Loaded, ReferenceRow, SchemaDrift, scanCsv } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  type Context,
  type Normalised,
  normalise,
  SOURCE,
  StationReference,
} from '../../src/adapters/lu-4/normalise.ts';
import { type Page, parsePage } from '../../src/adapters/lu-4/parse.ts';
import { ADAPTER } from '../../src/load/wire/lu-4.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// LU-4 AGE station pages (owner audience; catalogue §2.6, §6.7): parse + normalise of hand-made synthetic pages
// (invariants 9 and 11: real structure, generated values) equal the committed goldens; only the `data-to-json`
// attribute is read (a page with a script, a comment and a div that hold decoys gives the same record); levelsMax 0
// is undefined; an impossible date and Hesperange's easting are handled as the catalogue says. The adapter is not
// loaded before P7a. `UPDATE_GOLDEN=1` rewrites the goldens.

const registryFile = new URL('../../../../registry/stations/lu-1.yaml', import.meta.url);
const lu1 = StationsFile.parse(parseYaml(readFileSync(registryFile, 'utf8'))).stations;
const slugOf = (id: string) => id.replace(/^lu\.age\./, '');
/** LU-1 slug → the LU-6 point, as the loader will build it from registry/stations/lu-1.yaml. */
const positions = new Map(
  lu1.flatMap((s) => (s.lon === null || s.lat === null ? [] : [[slugOf(s.id), { lon: s.lon, lat: s.lat }] as const])),
);
const ctx = (station: string): Context => ({ station, positions });

function golden(name: string, actual: Normalised): Normalised {
  const url = goldenUrl('LU-4', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const fixture = (name: string) => rawFixture('LU-4', name).body;
const run = (name: string, station: string): Normalised => normalise(parsePage(fixture(name)), ctx(station));
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof SchemaDrift) return err.code;
    throw err;
  }
  return 'no error';
};

/** A page around an attribute object, encoded as a browser would read it back. */
const enc = (o: unknown) =>
  JSON.stringify(o).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&#34;');
const html = (o: unknown) =>
  `<html><body><cmp-dashboard-station data-to-json="${enc(o)}"></cmp-dashboard-station></body></html>`;
const bytes = (s: string) => new TextEncoder().encode(s);
/** The generated page of the fixtures, parsed: the starting point of the rule tests. */
const base = (): Page => parsePage(fixture('lu-4-page-normal.synthetic'));
const withPage = (change: Partial<Page>): Page => ({ ...base(), ...change });
const norm = (change: Partial<Page>, station = 'mersch') => normalise(withPage(change), ctx(station));

describe('golden files (synthetic pages, generated values)', () => {
  it('a normal page: levels, HQ lines, zero with its date, river km, LUREF position, banner and operator', () => {
    const out = run('lu-4-page-normal.synthetic', 'mersch');
    expect(out).toEqual(golden('lu-4-page-normal.synthetic', out));
    expect(StationReference.parse(out.record)).toEqual(out.record);
    expect(out.record.levels).toEqual({ yellow: 287, orange: 341, red: 393 });
    // HQ 2, HQ5, HQ10, HQ50, HQ100 as levels in cm and the reference flood; "HQ 20 ans" has value 0.
    expect(out.record.hq.map((h) => [h.kind, h.value_cm])).toEqual([
      ['HQ2', 301],
      ['HQ5', 322],
      ['HQ10', 340],
      ['HQ50', 371],
      ['HQ100', 389],
      ['LU4_CRUE_REF', 410],
    ]);
    expect(out.dropped).toEqual({ undefined_hq: 1 });
    expect(out.record.zero).toEqual({ value_m: 142.37, datum: 'NG95', valid_from: '2011-03-14' });
    expect(out.record.pk_km).toBe(27.4);
    expect(out.record.position).toEqual({ crs: 'EPSG:2169', e: 72155, n: 93410, from: 'page' });
    expect(out.record.forecast_limit_h).toBe(48);
    expect(out.record.forecast_slug).toBe('mersch');
    // The banner is provider text: kept as text, markup and all, never interpreted.
    expect(out.record.banner).toBe('Generated note <b>not markup</b> & "quoted". Station d’alerte (generated).');
    expect(out.record.operator).toBe('Generated Operator');
  });

  it('only the attribute of the element is read: a script, a comment and a div with decoy attributes change nothing', () => {
    const decoy = fixture('lu-4-page-decoy.synthetic').toString('utf8');
    // The decoys are there: four copies of the evil attribute outside the element.
    expect(decoy.match(/&#34;id&#34;:&#34;evil&#34;/g)?.length).toBeGreaterThanOrEqual(5);
    const out = run('lu-4-page-decoy.synthetic', 'mersch');
    expect(out).toEqual(golden('lu-4-page-decoy.synthetic', out));
    expect(out).toEqual(run('lu-4-page-normal.synthetic', 'mersch'));
    expect(out.record.page_id).toBe('Mersch');
    // And the two goldens are the same file content.
    const read = (n: string) => JSON.parse(readFileSync(goldenUrl('LU-4', n), 'utf8'));
    expect(read('lu-4-page-decoy.synthetic')).toEqual(read('lu-4-page-normal.synthetic'));
  });

  it('an impossible service date (99.999999, at Heiderscheidergrund): valid_from null, the zero kept, bad_date counted', () => {
    const out = run('lu-4-page-bad-date.synthetic', 'heiderscheidergrund');
    expect(out).toEqual(golden('lu-4-page-bad-date.synthetic', out));
    expect(out.record.zero).toEqual({ value_m: 317.52, datum: 'NG95', valid_from: null });
    expect(out.dropped).toEqual({ bad_date: 1 });
    expect(out.record.levels).toEqual({ yellow: null, orange: 255, red: 301 });
    expect(out.record.pk_km).toBe(12.8);
    expect(out.record.forecast_limit_h).toBe(24);
    expect(out.record.position).toEqual({ crs: 'EPSG:2169', e: 57234, n: 105891, from: 'page' });
  });

  it("an easting such as Hesperange's (999999 here) is no LUREF coordinate: the position is the LU-6 point of lu.age.hesperange", () => {
    const out = run('lu-4-page-hesperange.synthetic', 'hesperange');
    expect(out).toEqual(golden('lu-4-page-hesperange.synthetic', out));
    const point = lu1.find((s) => s.id === 'lu.age.hesperange');
    expect(point?.lon).not.toBeNull();
    expect(out.record.position).toEqual({ lon: point?.lon, lat: point?.lat, from: 'lu-6' });
    expect(out.dropped).toEqual({ undefined_hq: 1, coordinates_from_lu6: 1 });
  });

  it('levelsMax all 0 is undefined (null); a zero that is no number, no river km, no date and an empty banner are null', () => {
    const out = run('lu-4-page-no-levels.synthetic', 'ettelbruck-alzette');
    expect(out).toEqual(golden('lu-4-page-no-levels.synthetic', out));
    expect(out.record.levels).toEqual({ yellow: null, orange: null, red: null });
    expect(out.record.hq).toEqual([]);
    expect(out.record.zero).toBeNull();
    expect(out.record.pk_km).toBeNull();
    expect(out.record.banner).toBeNull();
    expect(out.record.forecast_limit_h).toBeNull();
    expect(out.record.forecast_slug).toBe('ettelbruck-alzette');
    expect(out.dropped).toEqual({ bad_zero: 1, bad_coordinates: 1, coordinates_from_lu6: 1 });
  });

  it('a page whose element has no data-to-json attribute is drift, a decoy in a script notwithstanding', () => {
    expect(code(() => parsePage(fixture('lu-4-page-no-attr.synthetic')))).toBe('html_attr');
  });

  it('the P1 capture fixture (the structure of the live page, every value generated) parses, with its odd strings counted', () => {
    const out = normalise(parsePage(fixture('lu-4-pages.synthetic')), ctx('mersch'));
    expect(out.record.levels).toEqual({ yellow: null, orange: 906, red: 765 });
    expect(out.record.hq).toEqual([]);
    expect(out.dropped).toEqual({
      unknown_hq: 6,
      bad_date: 1,
      bad_zero: 1,
      bad_pk: 1,
      bad_coordinates: 1,
      coordinates_from_lu6: 1,
      bad_forecast_limit: 1,
    });
    expect(out.record.forecast_slug).toBe('synthetic-1');
  });
});

describe('seed list', () => {
  const seed = scanCsv(readFileSync(new URL('../../../../registry/seed/lu-4.csv', import.meta.url), 'utf8'), {
    delimiter: ',',
    commentPrefix: '#',
  });
  const rows = seed.rows.map((r) => ({ path: r[0] as string, station: r[1] as string }));

  it('has the path column first and a station column that is an LU-1 slug, one per page', () => {
    expect(seed.header).toEqual(['path', 'station']);
    expect(rows).toHaveLength(40);
    const slugs = new Set(lu1.map((s) => slugOf(s.id)));
    for (const r of rows) expect([r.path, slugs.has(r.station)]).toEqual([r.path, true]);
    expect(new Set(rows.map((r) => r.station)).size).toBe(rows.length);
    // The four pages whose slug differs from the LU-1 slug.
    const differs = rows.filter((r) => r.path.split('/').at(-1) !== r.station).map((r) => [r.path, r.station]);
    expect(differs).toEqual([
      ['alzette/eisch/hunnebour', 'hunnebuer'],
      ['moselle/gander/mondorf', 'mondorf-les-bains'],
      ['moselle/syre/roodt-syre', 'roodt-sur-syre'],
      ['sure/sure/barrage-esch-sauer', 'esch-sure'],
    ]);
  });

  it('every station has the LU-6 point that LU-1 has for it, and the RLP gauges are not in the list', () => {
    for (const r of rows) {
      const s = lu1.find((x) => slugOf(x.id) === r.station);
      expect([r.station, positions.has(r.station)]).toEqual([r.station, s?.lon != null && s?.lat != null]);
    }
    expect(rows.map((r) => r.station)).not.toEqual(expect.arrayContaining(['bollendorf']));
    expect(rows.some((r) => /bollendorf|gemund/.test(r.station))).toBe(false);
    expect(positions.size).toBeGreaterThanOrEqual(30);
  });
});

describe('rules (synthetic)', () => {
  it('a level of 0 is undefined (null) at any position; another value is kept as published', () => {
    const lv = (a: number, b: number, c: number) =>
      norm({
        levelsMax: [
          { value: a, label: 'a' },
          { value: b, label: 'b' },
          { value: c, label: 'c' },
        ],
      }).record.levels;
    expect(lv(0, 0, 0)).toEqual({ yellow: null, orange: null, red: null });
    expect(lv(530, 0, 650)).toEqual({ yellow: 530, orange: null, red: 650 });
    expect(lv(0, 12, 0)).toEqual({ yellow: null, orange: 12, red: null });
  });

  it('the HQ legend names the kind; HQ100 is not HQ10 and HQ20 not HQ2; a kind twice keeps the first', () => {
    const list = (legends: [string, number][]) =>
      norm({ newVigilanceList: legends.map(([legend, value]) => ({ legend, value })) });
    const out = list([
      ['HQ100', 100],
      ['hq 20', 20],
      ['HQ  2', 2],
      ['Niveau HQ5 (cm)', 5],
      ['HQ10', 10],
      ['HQ10', 11],
      ['HQ200', 200],
      ['HQ1', 1],
      ['', 7],
      ['HQ50', 0],
    ]);
    expect(out.record.hq).toEqual([
      { kind: 'HQ100', value_cm: 100 },
      { kind: 'HQ20', value_cm: 20 },
      { kind: 'HQ2', value_cm: 2 },
      { kind: 'HQ5', value_cm: 5 },
      { kind: 'HQ10', value_cm: 10 },
    ]);
    expect(out.dropped).toEqual({ duplicate_hq: 1, unknown_hq: 3, undefined_hq: 1 });
  });

  it('zeroScale: metres on NG95 with a decimal point or comma; anything else is bad_zero', () => {
    const zero = (s: string) => norm({ zeroScale: s, serviceDate: '02.01.2099' });
    expect(zero('999.99 m NN').record.zero).toEqual({ value_m: 999.99, datum: 'NG95', valid_from: '2099-01-02' });
    expect(zero(' 999,99 m NN ').record.zero?.value_m).toBe(999.99);
    expect(zero('999.99m').record.zero?.value_m).toBe(999.99);
    expect(zero('223 M nn').record.zero?.value_m).toBe(223);
    expect(zero('').record).toMatchObject({ zero: null });
    expect(zero('').dropped).toEqual({ undefined_hq: 1 });
    for (const bad of ['999.99', '999.99 cm', '999.99 m NG', '0 m NN', '1500 m NN', '-3 m NN', '1.2.3 m NN', 'abc']) {
      const out = zero(bad);
      expect([bad, out.record.zero]).toEqual([bad, null]);
      expect([bad, out.dropped.bad_zero]).toEqual([bad, 1]);
    }
  });

  it('zeroScale as AGE writes it (2026-10-02): a decimal comma and a trailing dot; `m NN.` alone is no zero', () => {
    const zero = (s: string) => norm({ zeroScale: s, serviceDate: '02.01.2099' });
    expect(zero('999,99 m NN.').record.zero).toMatchObject({ value_m: 999.99, datum: 'NG95' });
    for (const none of ['m NN.', 'm NN']) {
      const out = zero(none);
      expect([none, out.record.zero, out.dropped.zero_missing, out.dropped.bad_zero]).toEqual([
        none,
        null,
        1,
        undefined,
      ]);
    }
  });

  it('coordinates as AGE writes them (2026-10-02): `<E> E | <N> N`', () => {
    const at = (coordinates: string) => norm({ coordinates }).record.position;
    expect(at('73651 E | 98123 N')).toEqual({ crs: 'EPSG:2169', e: 73651, n: 98123, from: 'page' });
    expect(at('86200 E | 101200 N')).toEqual({ crs: 'EPSG:2169', e: 86200, n: 101200, from: 'page' });
  });

  it('serviceDate: dd.mm.yyyy of the calendar → YYYY-MM-DD; any other string is null and bad_date', () => {
    const from = (s: string) => norm({ serviceDate: s });
    for (const [text, iso] of [
      ['14.03.2011', '2011-03-14'],
      ['29.02.2024', '2024-02-29'],
      ['31.12.1999', '1999-12-31'],
      [' 02.01.2099 ', '2099-01-02'],
    ] as const)
      expect([text, from(text).record.zero?.valid_from]).toEqual([text, iso]);
    for (const bad of ['99.999999', '29.02.2023', '31.04.2020', '00.01.2020', '1.1.2020', '2099-01-02', '15.13.2020'])
      expect([bad, from(bad).record.zero?.valid_from, from(bad).dropped.bad_date]).toEqual([bad, null, 1]);
    expect(from('').record.zero?.valid_from).toBeNull();
    expect(from('').dropped.bad_date).toBeUndefined();
  });

  it('pk: kilometres with a decimal point or comma; anything else is bad_pk', () => {
    const pk = (s: string) => norm({ pk: s });
    expect(pk('27,4 km').record.pk_km).toBe(27.4);
    expect(pk('27.4').record.pk_km).toBe(27.4);
    expect(pk('0').record.pk_km).toBe(0);
    expect(pk('').record.pk_km).toBeNull();
    expect(pk('').dropped.bad_pk).toBeUndefined();
    for (const bad of ['km 27', '27 miles', '-4', '1.2.3', 'x'])
      expect([bad, pk(bad).record.pk_km, pk(bad).dropped.bad_pk]).toEqual([bad, null, 1]);
  });

  it('coordinates: the LUREF easting and northing in Luxembourg; else the LU-6 point, else null', () => {
    const at = (s: string, station = 'mersch') => norm({ coordinates: s }, station);
    for (const text of [
      'E 72155 / N 93410',
      '72155 93410',
      '72155;93410',
      '72155, 93410',
      'E: 72155 N: 93410',
      'e72155/n93410',
    ])
      expect([text, at(text).record.position]).toEqual([text, { crs: 'EPSG:2169', e: 72155, n: 93410, from: 'page' }]);
    expect(at('72155,5 / 93410,25').record.position).toMatchObject({ e: 72155.5, n: 93410.25, from: 'page' });
    expect(at('45000 55000').record.position).toMatchObject({ from: 'page' });
    expect(at('110000 140000').record.position).toMatchObject({ from: 'page' });
    const lu6 = positions.get('mersch');
    expect(lu6).toBeDefined();
    for (const text of ['44999 93410', '72155 140001', '999999 76234', '72155 54999', '0 0'])
      expect([text, at(text).record.position, at(text).dropped]).toEqual([
        text,
        { ...lu6, from: 'lu-6' },
        { undefined_hq: 1, coordinates_from_lu6: 1 },
      ]);
    // Unparsable: counted, and the LU-6 point stands in; nothing at all when LU-6 has none (Perl).
    expect(at('somewhere').dropped.bad_coordinates).toBe(1);
    expect(at('somewhere').record.position).toMatchObject({ from: 'lu-6' });
    expect(positions.has('perl')).toBe(false);
    expect(at('999999 76234', 'perl').record.position).toBeNull();
    expect(at('999999 76234', 'perl').dropped.coordinates_from_lu6).toBeUndefined();
    expect(at('', 'perl').record.position).toBeNull();
    expect(at('').record.position).toMatchObject({ from: 'lu-6' });
  });

  it('forecastsLimit h24 or h48 (any case) → hours; another string is bad_forecast_limit', () => {
    const lim = (s: string) => norm({ forecastsLimit: s });
    expect([lim('h24'), lim('H48'), lim('h48')].map((o) => o.record.forecast_limit_h)).toEqual([24, 48, 48]);
    expect(lim('h12').record.forecast_limit_h).toBeNull();
    expect(lim('h12').dropped.bad_forecast_limit).toBe(1);
    expect(lim('').dropped.bad_forecast_limit).toBeUndefined();
  });

  it('the forecast slug is the AGE slug of forecastsFileName, else of the id', () => {
    const slug = (id: string, file?: string) =>
      norm({ id, ...(file === undefined ? { forecastsFileName: undefined } : { forecastsFileName: file }) }).record
        .forecast_slug;
    expect(slug('Mersch')).toBe('mersch');
    expect(slug('Ettelbrück / Alzette')).toBe('ettelbruck-alzette');
    expect(slug('Mersch', 'Ettelbrück-/-Alzette')).toBe('ettelbruck-alzette');
    expect(slug('Gemünd / Our', '  ')).toBe('gemund-our');
  });

  it('the banner and the operator are trimmed text, empty is null', () => {
    expect(norm({ bannerInfoText: '  <script>alert(1)</script>\n' }).record.banner).toBe('<script>alert(1)</script>');
    expect(norm({ bannerInfoText: '\n ' }).record.banner).toBeNull();
    expect(norm({ operator: '' }).record.operator).toBeNull();
    expect(norm({ operator: ' AGE ' }).record.operator).toBe('AGE');
  });

  it('no timestamps: no TIME is declared', () => {
    expect(SOURCE).toBe('LU-4');
  });
});

describe('the archive-derived fixtures (fixtures:synth: real structure, generated values)', () => {
  // Real structure and the identifiers the registry publishes; every other value is generated. Each page's station is
  // the `station` column of its row in registry/seed/lu-4.csv (its page path is the fixture's manifest variant).
  const seed = scanCsv(readFileSync(new URL('../../../../registry/seed/lu-4.csv', import.meta.url), 'utf8'), {
    delimiter: ',',
    commentPrefix: '#',
  });
  const stationOf = (path: string) => seed.rows.find((r) => r[0] === path)?.[1] as string;
  const pages = [
    ['lu-4-pages-hesperange.synthetic', 'alzette/alzette/hesperange'],
    ['lu-4-pages-heiderscheidergrund.synthetic', 'sure/sure/heiderscheidergrund'],
    ['lu-4-pages-stadtbredimus.synthetic', 'moselle/moselle/stadtbredimus'],
  ] as const;
  // A gap of the adapter, reported and not worked around: a page with `addForecasts: false` (Heiderscheidergrund) has
  // no `legendForecasts` key, and the strict schema of parse.ts requires it (`SchemaDrift('invalid_type')` at
  // `legendForecasts`). Make it optional (a reviewed change of parse.ts), then drop this set.
  const BLOCKED = new Set<string>();
  // A second gap, pinned by the goldens as they are: `zeroScale` of the archived pages ends in a dot (`… m NN.`), which the
  // anchored ZERO pattern of normalise.ts refuses, so every zero is `bad_zero` (null). Accept the dot, regenerate the goldens.

  for (const [name, path] of pages) {
    if (BLOCKED.has(name)) {
      it.todo(`${name}: ${path} (blocked: the page has no legendForecasts, which parse.ts requires)`);
      continue;
    }
    it(`${name}: ${path} normalises to a StationReference of its LU-1 station`, () => {
      const station = stationOf(path);
      expect(station).toEqual(expect.any(String));
      const out = run(name, station);
      expect(out).toEqual(golden(name, out));
      expect(StationReference.parse(out.record)).toEqual(out.record);
      expect(out.record.station).toBe(station);
      expect(out.record.page_id).not.toBe('');
      // The page's own position, or else the LU-6 point of its LU-1 station: never none for a seeded station.
      expect(positions.has(station)).toBe(true);
      expect(out.record.position).not.toBeNull();
      expect(out.dropped).not.toHaveProperty('bad_forecast_limit');
    });
  }
});

describe('strict parse', () => {
  const page = (): Record<string, unknown> => JSON.parse(JSON.stringify(base()));
  const drift = (change: (p: Record<string, unknown>) => void) => {
    const p = page();
    change(p);
    return code(() => parsePage(bytes(html(p))));
  };

  it('the generated page round-trips through the page and the attribute encoding', () => {
    expect(parsePage(bytes(html(page())))).toEqual(base());
  });

  it('refuses another shape with Zod’s issue code', () => {
    expect(drift((p) => delete p.id)).toBe('invalid_type');
    expect(drift((p) => delete p.levelsMax)).toBe('invalid_type');
    expect(drift((p) => (p.extra = 1))).toBe('unrecognized_keys');
    expect(drift((p) => (p.showImage = 'yes'))).toBe('invalid_type');
    expect(drift((p) => (p.startYAxis = 1.5))).toBe('invalid_type');
    expect(drift((p) => (p.id = ''))).toBe('too_small');
    expect(drift((p) => (p.levelsMax = (p.levelsMax as unknown[]).slice(0, 2)))).toBe('too_small');
    expect(drift((p) => (p.levelsMax = [...(p.levelsMax as unknown[]), (p.levelsMax as unknown[])[0]]))).toBe(
      'too_big',
    );
    expect(drift((p) => (p.levelsMax = [1, 2, 3]))).toBe('invalid_type');
    expect(drift((p) => (p.newVigilanceList = Array.from({ length: 13 }, () => ({ legend: 'HQ2', value: 1 }))))).toBe(
      'too_big',
    );
    expect(
      drift((p) => (p.logosHeaderPath = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])))),
    ).toBe('custom');
    expect(drift((p) => (p.logosHeaderPath = { a: 1 }))).toBe('invalid_type');
  });

  it('caps every string: 500 characters, the two notes 20,000', () => {
    expect(drift((p) => (p.stationName = 'x'.repeat(501)))).toBe('too_big');
    expect(drift((p) => (p.stationName = 'x'.repeat(500)))).toBe('no error');
    expect(drift((p) => (p.bannerInfoText = 'x'.repeat(20_001)))).toBe('too_big');
    expect(drift((p) => (p.bannerInfoText = 'x'.repeat(20_000)))).toBe('no error');
    expect(drift((p) => (p.otherInfo = 'x'.repeat(20_001)))).toBe('too_big');
  });

  it('refuses a page that is no page: no element, two elements, bad JSON, bytes that are no UTF-8', () => {
    expect(code(() => parsePage(bytes('<html><body>Service unavailable</body></html>')))).toBe('html_tag');
    expect(code(() => parsePage(bytes(html(page()) + html(page()))))).toBe('html_tag_count');
    expect(code(() => parsePage(bytes('<cmp-dashboard-station data-to-json="{&#34;id&#34;:">')))).toBe('html_json');
    expect(code(() => parsePage(bytes(html([1, 2]))))).toBe('invalid_type');
    expect(code(() => parsePage(new Uint8Array([0x3c, 0xff, 0xfe, 0x3e])))).toBe('encoding');
  });
});

describe('property and fuzz', () => {
  const str = (max = 30) => fc.string({ maxLength: max });
  const number = fc.integer({ min: -1000, max: 20_000 });
  const level = fc.record({ value: number, label: str() });
  const legend = fc.oneof(fc.constantFrom('HQ2', 'HQ 5', 'hq10', 'HQ20', 'HQ50', 'HQ100', 'HQ200', 'Crue', ''), str());
  const attribute = fc.record(
    {
      id: fc.string({ minLength: 1, maxLength: 30 }),
      levelsMax: fc.tuple(level, level, level),
      vigilanceThreshold: number,
      jsonFile: str(),
      legendForecasts: str(),
      forecastsLimit: fc.oneof(fc.constantFrom('h24', 'h48', ''), str()),
      forecastsFileName: str(),
      showImage: fc.boolean(),
      imagePath: str(),
      putLogoHeader: fc.boolean(),
      logosHeaderPath: fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), str(), { maxKeys: 5 }),
      stationPath: str(),
      startYAxis: number,
      endYAxis: number,
      stepYAxis: number,
      isDashboard: fc.boolean(),
      bannerInfoText: str(60),
      displayInfoBanner: fc.boolean(),
      stationName: str(),
      waterCourse: str(),
      basinVersion: str(),
      zeroScale: fc.oneof(
        fc.constantFrom('999.99 m NN', '12,5 m', '0 m NN', ''),
        str(),
        fc.double({ min: -50, max: 2000 }).map((d) => `${d} m NN`),
      ),
      pk: fc.oneof(fc.constantFrom('27,4 km', '3', ''), str()),
      coordinates: fc.oneof(
        fc.constantFrom('E 72155 / N 93410', '999999 76234', ''),
        str(),
        fc.tuple(number, number).map(([e, n]) => `${e * 7} ${n * 7}`),
      ),
      repTel: str(),
      serviceDate: fc.oneof(
        fc.constantFrom('14.03.2011', '99.999999', ''),
        str(),
        fc
          .tuple(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 0, max: 14 }), fc.integer({ min: 1700, max: 2300 }))
          .map(([d, m, y]) => `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`),
      ),
      serviceStatus: str(),
      operator: str(),
      forecastsCalcul: str(),
      otherInfo: str(60),
      moreInfoBtn: str(),
      imageStationPath: str(),
      addNewVigilance: fc.boolean(),
      newVigilanceList: fc.array(fc.record({ legend, value: number }), { maxLength: 12 }),
      addForecasts: fc.boolean(),
    },
    { requiredKeys: Object.keys(base()).filter((k) => k !== 'forecastsFileName') as never },
  );

  it('a generated attribute object parses back unchanged and normalises to a valid record', () => {
    fc.assert(
      fc.property(attribute, fc.constantFrom('mersch', 'hesperange', 'perl', 'x'), (obj, station) => {
        const parsed = parsePage(bytes(html(obj)));
        expect(parsed).toEqual(obj);
        const out = normalise(parsed, ctx(station));
        expect(StationReference.safeParse(out.record).success).toBe(true);
        for (const [k, n] of Object.entries(out.dropped)) expect([k, n > 0]).toEqual([k, true]);
        // Where the page states three levels, 0 is null and nothing else is.
        expect(Object.values(out.record.levels)).toEqual(obj.levelsMax.map((l) => (l.value === 0 ? null : l.value)));
      }),
      { numRuns: 300 },
    );
  });

  it('arbitrary bytes into parse throw only SchemaDrift', () => {
    const soup = fc
      .array(
        fc.constantFrom(
          '<',
          '>',
          '"',
          "'",
          '=',
          ' ',
          '<cmp-dashboard-station',
          ' data-to-json=',
          '&#34;',
          '{',
          '}',
          '[',
          ']',
          ':',
          ',',
          '<!--',
          '-->',
          '<script',
        ),
        { maxLength: 30 },
      )
      .map((p) => bytes(p.join('')));
    fc.assert(
      fc.property(fc.oneof(fc.uint8Array({ maxLength: 200 }), soup), (input) => {
        try {
          parsePage(input);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('an attribute that is JSON but not a page throws only SchemaDrift', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        try {
          parsePage(bytes(html(value)));
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('references (P7a: the page as reference rows of the LU-1, LU-2 and twin DE-1 series)', () => {
  const regs = new Map([
    ['LU-1', registryOf('LU-1')],
    ['LU-2', registryOf('LU-2')],
    ['DE-1', registryOf('DE-1')],
  ]);
  const wire = ADAPTER.specs['lu-4-pages'];
  const path = (fixtureName: string) =>
    ({
      'lu-4-page-normal.synthetic': 'alzette/alzette/mersch',
      'lu-4-page-orange-changed.synthetic': 'alzette/alzette/mersch',
      'lu-4-page-no-levels.synthetic': 'alzette/alzette/ettelbruck-alzette',
      'lu-4-pages-stadtbredimus.synthetic': 'moselle/moselle/stadtbredimus',
      'lu-4-pages-hesperange.synthetic': 'alzette/alzette/hesperange',
    })[fixtureName] as string;
  const load = (name: string, variant = path(name)) => {
    if (wire === undefined) throw new Error('no lu-4-pages loader');
    return wire.run(new Uint8Array(fixture(name)), {
      registry: new Map(),
      fetchedAt: Date.parse('2030-01-01T00:00:00Z'),
      variant,
      unitMismatch: new Set(),
      refRegistries: regs,
    }) as Loaded;
  };

  it('the loader wiring: owner source LU-4, a variant per page, the three target registries, no timestamps', () => {
    expect(wire?.needsVariant).toBe(true);
    expect(wire?.refTarget).toEqual(['LU-1', 'LU-2', 'DE-1']);
    expect(wire?.maxBytes).toBe(4 * 1024 * 1024);
  });

  it('a normal page: yellow, orange, red, six HQ lines and the reference flood on Mersch of LU-1 and of LU-2, in cm', () => {
    const out = load('lu-4-page-normal.synthetic');
    const rows = out.references ?? [];
    for (const r of rows) ReferenceRow.parse(r);
    const lu1 = rows.filter((r) => r.target === 'LU-1');
    const lu2 = rows.filter((r) => r.target === 'LU-2');
    expect(lu1.map((r) => [r.kind, r.value, r.semantics])).toEqual([
      ['LU4_YELLOW', 287, 'operational'],
      ['LU4_ORANGE', 341, 'operational'],
      ['LU4_RED', 393, 'operational'],
      ['HQ2', 301, 'statistical'],
      ['HQ5', 322, 'statistical'],
      ['HQ10', 340, 'statistical'],
      ['HQ50', 371, 'statistical'],
      ['HQ100', 389, 'statistical'],
      ['LU4_CRUE_REF', 410, 'historical'],
    ]);
    expect(lu2.map((r) => [r.kind, r.value])).toEqual(lu1.map((r) => [r.kind, r.value]));
    expect(rows).toHaveLength(18);
    const keysOf = (source: string, station: string) =>
      [...(regs.get(source) ?? [])].filter(([, d]) => d.station === station).map(([k]) => k);
    expect(new Set(rows.map((r) => r.series))).toEqual(
      new Set([...keysOf('LU-1', 'lu.age.mersch'), ...keysOf('LU-2', 'lu.age-json.mersch')]),
    );
    for (const r of rows) {
      expect([r.unit, r.convention, r.period, r.basis_label, r.valid_from, r.priority]).toEqual([
        'cm',
        null,
        null,
        'AGE',
        null,
        0,
      ]);
      expect([r.season_from_md, r.season_to_md]).toEqual([101, 1231]);
    }
    // Nothing of the page's labels ("Vigilance jaune", "HQ 20 ans") or of its gauge zero is carried.
    expect(JSON.stringify(out)).not.toMatch(/Vigilance|jaune|142\.37/);
    expect(out.gaugeZeros).toEqual([]);
    expect(out.obs).toEqual([]);
    expect(out.dropped).toEqual({ undefined_hq: 1 });
    // The scope is every target series, so a level the page stops stating is closed.
    expect(out.refScope).toEqual(
      [...new Set(rows.map((r) => `${r.target}\n${r.series}`))].map((k) => ({
        target: k.split('\n')[0],
        series: k.split('\n')[1],
      })),
    );
  });

  it('a Moselle gauge also takes its references on the DE-1 series that twins.yaml pairs with its LU-1 series', () => {
    const out = load('lu-4-pages-stadtbredimus.synthetic');
    const rows = out.references ?? [];
    const de1 = rows.filter((r) => r.target === 'DE-1');
    expect(new Set(de1.map((r) => r.series))).toEqual(new Set(['dfdf753b-75bd-46f0-8cde-15545be9bfba/W']));
    expect(de1.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.target === 'LU-1').map((r) => r.series)).toContain('SN_Stadtbredimus');
    expect(rows.filter((r) => r.target === 'LU-2').length).toBeGreaterThan(0);
    // The same kinds and values on all three.
    const kv = (t: string) => rows.filter((r) => r.target === t).map((r) => [r.kind, r.value]);
    expect(kv('DE-1')).toEqual(kv('LU-1'));
    expect(out.refScope?.map((x) => x.target).sort()).toEqual(['DE-1', 'LU-1', 'LU-2']);
    // A gauge that is no twin takes none.
    expect(load('lu-4-page-normal.synthetic').references?.some((r) => r.target === 'DE-1')).toBe(false);
  });

  it('golden: the page with the orange level changed (341 → 352) differs from the normal page in that level only', () => {
    const out = run('lu-4-page-orange-changed.synthetic', 'mersch');
    expect(out).toEqual(golden('lu-4-page-orange-changed.synthetic', out));
    expect(out.record.levels).toEqual({ yellow: 287, orange: 352, red: 393 });
  });

  it('a changed orange level changes only LU4_ORANGE', () => {
    const [a, b] = [load('lu-4-page-normal.synthetic'), load('lu-4-page-orange-changed.synthetic')];
    const diff = (b.references ?? []).filter((r, i) => JSON.stringify(r) !== JSON.stringify(a.references?.[i]));
    expect(new Set(diff.map((r) => [r.kind, r.value].join(':')))).toEqual(new Set(['LU4_ORANGE:352']));
    expect(diff).toHaveLength(2);
    expect(b.references).toHaveLength(a.references?.length ?? -1);
    expect(a.refScope).toEqual(b.refScope);
  });

  it('a page with no levels and no HQ still states its series (scope) and no row; an unregistered gauge states nothing', () => {
    const none = load('lu-4-page-no-levels.synthetic');
    expect(none.references).toEqual([]);
    expect(none.refScope?.length).toBeGreaterThan(0);
    // Hesperange in a registry without LU-2 and DE-1: only LU-1.
    const hes = wire?.run(new Uint8Array(fixture('lu-4-pages-hesperange.synthetic')), {
      registry: new Map(),
      fetchedAt: 0,
      variant: path('lu-4-pages-hesperange.synthetic'),
      unitMismatch: new Set(),
      refRegistries: new Map([['LU-1', regs.get('LU-1') as never]]),
    }) as Loaded;
    expect(new Set(hes.references?.map((r) => r.target))).toEqual(new Set(['LU-1']));
    const nowhere = wire?.run(new Uint8Array(fixture('lu-4-pages-hesperange.synthetic')), {
      registry: new Map(),
      fetchedAt: 0,
      variant: path('lu-4-pages-hesperange.synthetic'),
      unitMismatch: new Set(),
    }) as Loaded;
    expect(nowhere.references).toEqual([]);
    expect(nowhere.refScope).toEqual([]);
  });

  it('a variant that is no seeded page is drift; a page that is no page is drift', () => {
    expect(code(() => load('lu-4-page-normal.synthetic', 'moselle/moselle/unknown'))).toBe('bad_variant');
    expect(
      code(() =>
        wire?.run(bytes('<html></html>'), {
          registry: new Map(),
          fetchedAt: 0,
          variant: path('lu-4-page-normal.synthetic'),
          unitMismatch: new Set(),
        }),
      ),
    ).toBe('html_tag');
  });

  it('the reference flood: "Crue de référence" in any case or accent, once; a second one is duplicate_hq, a zero undefined', () => {
    const lines = (legends: [string, number][]) =>
      norm({ newVigilanceList: legends.map(([legend, value]) => ({ legend, value })) }).record.hq;
    expect(lines([['Crue de référence', 410]])).toEqual([{ kind: 'LU4_CRUE_REF', value_cm: 410 }]);
    expect(lines([['CRUE DE REFERENCE 2011', 5]])).toEqual([{ kind: 'LU4_CRUE_REF', value_cm: 5 }]);
    expect(lines([['Crue de référence', 0]])).toEqual([]);
    expect(
      norm({
        newVigilanceList: [
          { legend: 'Crue de référence', value: 1 },
          { legend: 'Crue de référence', value: 2 },
        ],
      }).dropped,
    ).toEqual({ duplicate_hq: 1 });
    expect(lines([['une crue de référence', 3]])).toEqual([]);
  });
});
