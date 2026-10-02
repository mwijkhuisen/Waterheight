import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type PublicStation, SourcesFile, StationsFile, validateStations } from '../packages/contracts/src/index.ts';
import {
  deriveSeries,
  deriveSeriesFiles,
  generate,
  type Inputs,
  MIRRORS,
  OUTPUT_FR1,
  OUTPUT_FR3,
  readInputs,
} from '../scripts/gen-fr1-stations.ts';
import { repoRoot } from './catalogue.ts';

// registry/stations/fr-1.yaml and fr-3.yaml are generated (scripts/gen-fr1-stations.ts) from the recorded
// Hub'Eau referentiel fixtures, the series list derived from a recording of one UTC day of live runs
// (registry/seed/fr-1-series.csv), the 18 Belgian partners and the 15 FR-3 key stations: the committed files
// are exactly the generator's output, and they hold what the catalogue (§3.1-§3.4, §0.6) says about the stations.

const committed = { fr1: readFileSync(OUTPUT_FR1, 'utf8'), fr3: readFileSync(OUTPUT_FR3, 'utf8') };
const inputs = readInputs();
const run = (change: Partial<Inputs> = {}) => generate({ ...inputs, ...change });
const sources = SourcesFile.parse(parse(readFileSync(`${repoRoot}registry/sources.yaml`, 'utf8'))).sources;
const rowsOf = (text: string) =>
  StationsFile.parse(parse(text)).stations.filter((s): s is PublicStation => s.audience !== 'owner');
const fr1 = rowsOf(committed.fr1);
const fr3 = rowsOf(committed.fr3);
const de1 = rowsOf(readFileSync(`${repoRoot}registry/stations/de-1.yaml`, 'utf8'));
const ch1 = rowsOf(readFileSync(`${repoRoot}registry/stations/ch-1.yaml`, 'utf8'));
const codes = (of: PublicStation[]) => [...new Set(of.map((r) => r.provider_code))].sort();
const stationIds = (of: PublicStation[]) => new Set(of.map((r) => r.id));
const find = (of: PublicStation[], code: string, quantity: 'H' | 'Q' = 'H') => {
  const row = of.find((r) => r.provider_code === code && r.quantity === quantity);
  if (row === undefined) throw new Error(`no row ${code} ${quantity}`);
  return row;
};
const seriesCodes = new Set(inputs.series.map((r) => r.code_station));

// Catalogue §3.1-§3.4, the bold stations (tier 1, first release), written out independently of the generator.
const TIER1 = [
  'A061005051',
  'A228003001',
  'A302009050',
  'A443064001',
  'A573061001',
  'A692101001',
  'A701061001',
  'A743061001',
  'A793061002',
  'A850061001',
  'A920107050',
  'A930108040',
  'B222001001',
  'B315002001',
  'B402101001',
  'B403101001',
  'B422431101',
  'B460101001',
  'B463101001',
  'B466010101',
  'B502001001',
  'B540001001',
  'B611101001',
  'B700001002',
  'B720000001',
  'D016221001',
  'D019801101',
  'D019223001',
  'E131000202',
  'E171551101',
  'E172751201',
  'E201000501',
  'E223000101',
  'E207111003',
  'E237110501',
  'E240041101',
  'E364121002',
  'E364121001',
  'E367125002',
  'E381126501',
];
const FORECAST = [
  'A443064001',
  'A573061001',
  'A701061001',
  'A850061001',
  'B315002001',
  'B466010101',
  'B502001001',
  'B540001001',
  'B611101001',
  'D019801101',
];
const FR3 = [
  'A061005051',
  'A302009050',
  'A443064001',
  'A573061001',
  'A743061001',
  'A850061001',
  'A940000101',
  'B315002001',
  'B502001001',
  'B540001001',
  'B611101001',
  'B720000001',
  'D019223001',
  'E240041101',
  'E381126501',
];
const PARTNERS = inputs.partners.map((r) => r.code_station ?? '');

/** The referentiel fixtures' stations by code. */
type Ref = {
  code_station: string;
  code_commune_station: string;
  libelle_station: string;
  libelle_cours_eau: string | null;
  longitude_station: number;
  latitude_station: number;
};
const ref = new Map(
  (inputs.ref as { data: Ref[] }[]).flatMap((p) => p.data).map((s): [string, Ref] => [s.code_station, s]),
);

describe('registry/stations/fr-1.yaml', () => {
  it('is exactly what the generator writes from its inputs', () => {
    expect(committed.fr1).toBe(run().fr1);
  });

  it('is deterministic: the same input gives the same bytes and no timestamp', () => {
    expect(run()).toEqual(run());
    expect(committed.fr1.slice(committed.fr1.indexOf('\nstations:'))).not.toMatch(/\d{2}:\d{2}/);
  });

  it('is unchanged by a YAML 1.1 reader (codes, numbers and "off" are quoted)', () => {
    expect(parse(committed.fr1, { version: '1.1' })).toEqual(parse(committed.fr1));
  });

  it('validates against the real sources with no problem', () => {
    expect(validateStations(parse(committed.fr1), sources).problems).toEqual([]);
  });

  it('names its inputs and their sha256 in the header', () => {
    for (const f of inputs.files) expect(committed.fr1).toContain(`${f.path}  sha256 ${f.sha256}`);
    expect(inputs.files.map((f) => f.path)).toHaveLength(9);
  });

  it('holds one row per series of the series list: 550 rows at 304 stations (300 H, 250 Q)', () => {
    expect(inputs.series).toHaveLength(550);
    // Every series of the list has a row: the excluded stations have none in the day export.
    expect(fr1.map((r) => r.provider_key).sort()).toEqual(
      inputs.series.map((r) => `${r.code_station}/${r.quantity}`).sort(),
    );
    expect(stationIds(fr1).size).toBe(304);
    expect(fr1.filter((r) => r.quantity === 'H')).toHaveLength(300);
    expect(fr1.filter((r) => r.quantity === 'Q')).toHaveLength(250);
    for (const r of fr1) {
      expect(r).toMatchObject({
        id: `fr.sandre.${r.provider_code}`,
        source: 'FR-1',
        provider_key: `${r.provider_code}/${r.quantity}`,
        river: null,
        km: null,
        licence_gate: 'open',
        gauge_zero: [],
        expected_threshold_source: null,
      });
      expect(r.flags).toEqual({ tidal: null, impounded: null });
    }
  });

  it('is ordered by code (code units), then H before Q', () => {
    const keys = fr1.map((r) => `${r.provider_code}/${r.quantity === 'H' ? 0 : 1}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('declares H as mm (x0.1, a stage with a local zero) and Q as l/s (x0.001), and no gauge zero of its own', () => {
    for (const r of fr1) {
      const h = r.quantity === 'H';
      expect([r.id, r.native_unit, r.to_canonical, r.value_kind, r.datum]).toEqual([
        r.id,
        h ? 'mm' : 'l/s',
        h ? 0.1 : 0.001,
        h ? 'stage' : null,
        h ? 'LOCAL' : null,
      ]);
    }
    // The loader stores the zero from the referentiel, flagged untrusted by its datum (IGN69, NGF1884): the registry
    // never declares a convertible datum for an FR-1 series.
    expect(new Set(fr1.map((r) => r.datum))).toEqual(new Set(['LOCAL', null]));
  });

  it('takes name, water, coordinates and country from the recorded referentiel (commune 99131 BE, 99109 DE, 99140 CH, else FR)', () => {
    const country = (commune: string) =>
      ({ '99131': 'BE', '99109': 'DE', '99140': 'CH' })[commune] ?? (commune.startsWith('99') ? '??' : 'FR');
    for (const r of fr1) {
      const s = ref.get(r.provider_code);
      expect([r.id, r.name, r.water_name, r.country]).toEqual([
        r.id,
        s?.libelle_station,
        s?.libelle_cours_eau,
        country(s?.code_commune_station ?? ''),
      ]);
      expect([r.lon, r.lat]).toEqual([s?.longitude_station, s?.latitude_station]);
    }
    expect(find(fr1, 'B720000001')).toMatchObject({ name: 'La Meuse à Chooz - Trou du Diable "DREAL"', country: 'FR' });
    expect(fr1.filter((r) => r.water_name === null)).not.toHaveLength(0);
  });

  it('keeps every name and water name within the label rule (200 characters, no control or format character)', () => {
    for (const r of fr1) {
      for (const text of [r.name, r.water_name ?? '']) {
        expect([r.id, text.length <= 200, /[\p{Cc}\p{Cf}]/u.test(text)]).toEqual([r.id, true, false]);
      }
    }
  });

  it('derives the steps from the day: expected = native, stale after max(3 steps, 90 min)', () => {
    const seen = new Set(fr1.map((r) => `${r.native_step} ${r.expected_step} ${r.staleness_limit}`));
    expect([...seen].sort()).toEqual([
      'PT10M PT10M PT90M',
      'PT15M PT15M PT90M',
      'PT1H PT1H PT3H',
      'PT5M PT5M PT90M',
      'PT6M PT6M PT90M',
    ]);
    const steps = new Map(inputs.series.map((r) => [`${r.code_station}/${r.quantity}`, r.native_step]));
    for (const r of fr1) expect([r.id, r.native_step]).toEqual([r.id, steps.get(r.provider_key)]);
  });

  it('marks exactly the 40 bold stations of §3.1-§3.4 (71 rows) as tier 1 and first_release, all primary', () => {
    const tier1 = fr1.filter((r) => r.tier === 1);
    expect(codes(tier1)).toEqual([...TIER1].sort());
    // Review CR-4: Torgny B422431101 (H and Q) is bold in §3.3, so tier 1, although a Belgian partner.
    expect(tier1).toHaveLength(71);
    expect(tier1.filter((r) => r.quantity === 'H')).toHaveLength(40);
    expect(tier1.filter((r) => r.quantity === 'Q')).toHaveLength(31);
    expect(tier1.every((r) => r.first_release && r.role === 'primary' && r.audience === 'public')).toBe(true);
    expect(codes(tier1.filter((r) => r.country !== 'FR'))).toEqual(['B422431101']);
    // Every other row is tier 2 and never first_release; the day export holds a series for every tier-1 station.
    expect(fr1.filter((r) => r.tier === 2).every((r) => !r.first_release)).toBe(true);
    for (const code of TIER1) expect(seriesCodes.has(code), code).toBe(true);
  });

  it('names FR-4 as the forecast source of the 10 §3 "F" stations (17 rows), no other', () => {
    const forecast = fr1.filter((r) => r.expected_forecast_source !== null);
    expect(codes(forecast)).toEqual([...FORECAST].sort());
    expect(forecast.every((r) => r.expected_forecast_source === 'FR-4')).toBe(true);
    expect(forecast).toHaveLength(17);
  });

  describe('the mirrors', () => {
    it('are the six gauges of other agencies, each with a primary that exists in DE-1 or CH-1', () => {
      expect([...MIRRORS.keys()].sort()).toEqual([
        'A021005050',
        'A040000101',
        'A060005050',
        'A355005050',
        'A375005050',
        'A940000101',
      ]);
      for (const [code, m] of MIRRORS) {
        const primary = (m.source === 'DE-1' ? de1 : ch1).filter((r) => r.provider_code === m.code);
        expect([code, primary.length > 0, primary.every((r) => r.role === 'primary' && r.source === m.source)]).toEqual(
          [code, true, true],
        );
        // The country of the mirror is the primary's: the foreign commune of the referentiel agrees.
        expect([code, primary[0]?.country]).toEqual([code, m.country]);
      }
      // Hanweiler (decision D-e): DE-1 26400100 is the primary (WSV, tier 1), Hub'Eau's zero is off by +1.57 m.
      expect(MIRRORS.get('A940000101')).toMatchObject({ source: 'DE-1', code: '26400100' });
      expect(find(de1, '26400100')).toMatchObject({ role: 'primary', tier: 1, first_release: true });
    });

    it('are role mirror, tier 2 and not first_release: all six have a series (Basel only in the seed fixtures, 9 rows)', () => {
      const registered = [...MIRRORS.keys()].filter((c) => seriesCodes.has(c)).sort();
      expect(registered).toEqual([...MIRRORS.keys()].sort());
      expect(codes(fr1.filter((r) => r.role === 'mirror'))).toEqual(registered);
      expect(fr1.filter((r) => r.role === 'mirror')).toHaveLength(9);
      for (const r of fr1.filter((x) => x.role === 'mirror')) {
        const basel = r.provider_code === 'A021005050';
        expect([r.id, r.tier, r.first_release, r.country, r.audience]).toEqual([
          r.id,
          2,
          false,
          basel ? 'CH' : 'DE',
          'public',
        ]);
      }
      expect(committed.fr1).toContain('mirrors without a series in the recording: none.');
    });
  });

  describe('the Belgian partners', () => {
    it('are the 18 stations of fr-1-be.csv, all recorded with commune 99131', () => {
      expect(PARTNERS).toHaveLength(18);
      for (const code of PARTNERS) expect(ref.get(code)?.code_commune_station, code).toBe('99131');
    });

    it('are registered as primary rows, country BE, public, tier 2 but bold Torgny: every partner that has a series in any input (all 18, 31 rows)', () => {
      const delivering = PARTNERS.filter((c) => seriesCodes.has(c)).sort();
      expect(delivering).toEqual([...PARTNERS].sort());
      const be = fr1.filter((r) => r.country === 'BE');
      expect(codes(be)).toEqual(delivering);
      expect(be).toHaveLength(31);
      for (const r of be) {
        const bold = r.provider_code === 'B422431101';
        expect([r.id, r.role, r.tier, r.first_release, r.audience, r.licence_gate]).toEqual([
          r.id,
          'primary',
          bold ? 1 : 2,
          bold,
          'public',
          'open',
        ]);
      }
      expect(committed.fr1).toContain('partners without a series in the recording: none.');
    });

    it('take the step of their series: hourly (PT1H, by rule where one point is all there is) but Menen 15 min, Thure and Hante 5-10 min', () => {
      const steps = new Map(inputs.series.map((r) => [`${r.code_station}/${r.quantity}`, r.native_step]));
      const measured = new Map([
        ['E381126601', 'PT15M'], // the Lys at Menen
        ['D022000101', 'PT5M'], // La Thure at Bersillies
        ['D022000201', 'PT10M'], // Hante at Beaumont
        ['D022000301', 'PT5M'], // Hante at Wiheries
        ['E182702501', 'PT10M'], // Trouille at Givry
      ]);
      for (const r of fr1.filter((x) => x.country === 'BE')) {
        const step = measured.get(r.provider_code) ?? 'PT1H';
        expect([r.id, r.native_step, r.expected_step, steps.get(r.provider_key)]).toEqual([r.id, step, step, step]);
        expect([r.id, r.staleness_limit]).toEqual([r.id, step === 'PT1H' ? 'PT3H' : 'PT90M']);
      }
      expect(fr1.filter((r) => r.country === 'BE' && r.native_step === 'PT1H')).toHaveLength(22);
    });
  });

  it('never registers the excluded stations (Tournai E240041201, Solre-Erquelinnes D021000101)', () => {
    for (const code of ['E240041201', 'D021000101']) {
      expect(fr1.filter((r) => r.provider_code === code)).toEqual([]);
      expect(seriesCodes.has(code)).toBe(false);
    }
    // A series that shows up for an excluded station is skipped, not registered, and not an error.
    const extra = { code_station: 'E240041201', quantity: 'H', native_step: 'PT1H', points: '3' };
    expect(run({ series: [...inputs.series, extra] }).fr1).toBe(committed.fr1);
  });

  it('registers the three foreign stations that are neither partner nor mirror with audience off, tier 2', () => {
    const off = fr1.filter((r) => r.audience === 'off');
    expect(codes(off)).toEqual(['A060005051', 'A937203050', 'A937204050']);
    expect(off).toHaveLength(5);
    expect(off.every((r) => r.role === 'primary' && r.tier === 2 && !r.first_release && r.country === 'DE')).toBe(true);
  });
});

describe('registry/stations/fr-3.yaml', () => {
  it('is exactly what the generator writes from its inputs, deterministic and YAML 1.1 safe', () => {
    expect(committed.fr3).toBe(run().fr3);
    expect(parse(committed.fr3, { version: '1.1' })).toEqual(parse(committed.fr3));
    expect(committed.fr3.slice(committed.fr3.indexOf('\nstations:'))).not.toMatch(/\d{2}:\d{2}/);
    expect(validateStations(parse(committed.fr3), sources).problems).toEqual([]);
  });

  it('holds the twins of the 15 key stations of fr-3.csv: 26 rows (15 H, 11 Q), role twin, tier 2, never first_release', () => {
    expect(inputs.fr3.map((r) => r.code)).toEqual(expect.arrayContaining(FR3));
    expect(codes(fr3)).toEqual([...FR3].sort());
    expect(fr3).toHaveLength(26);
    expect(fr3.filter((r) => r.quantity === 'H')).toHaveLength(15);
    expect(fr3.filter((r) => r.quantity === 'Q')).toHaveLength(11);
    for (const r of fr3) {
      expect(r).toMatchObject({
        id: `fr.vigicrues.${r.provider_code}`,
        source: 'FR-3',
        role: 'twin',
        tier: 2,
        first_release: false,
        staleness_limit: 'PT12H',
        expected_threshold_source: null,
        expected_forecast_source: null,
        licence_gate: 'open',
        audience: 'public',
        gauge_zero: [],
      });
    }
  });

  it('is ordered by code, then H before Q', () => {
    const keys = fr3.map((r) => `${r.provider_code}/${r.quantity === 'H' ? 0 : 1}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('declares H as m (x100, stage, LOCAL) and Q as m³/s (x1)', () => {
    for (const r of fr3) {
      const h = r.quantity === 'H';
      expect([r.id, r.native_unit, r.to_canonical, r.value_kind, r.datum]).toEqual([
        r.id,
        h ? 'm' : 'm³/s',
        h ? 100 : 1,
        h ? 'stage' : null,
        h ? 'LOCAL' : null,
      ]);
    }
  });

  it('is the twin of an FR-1 series on the same key, with its name, coordinates, country and step (the gap-fill grid)', () => {
    for (const r of fr3) {
      const twin = fr1.find((x) => x.provider_key === r.provider_key);
      expect(twin, r.provider_key).toBeDefined();
      expect([r.name, r.water_name, r.lon, r.lat, r.country, r.native_step, r.expected_step]).toEqual([
        twin?.name,
        twin?.water_name,
        twin?.lon,
        twin?.lat,
        twin?.country,
        twin?.native_step,
        twin?.expected_step,
      ]);
      // A gap-fill needs an FR-1 primary under the same key. Hanweiler is the one FR-3 key station that FR-1 holds
      // as a mirror (decision D-e): its twin has no target to fill, which the loader counts as unknown.
      expect([r.provider_key, twin?.role]).toEqual([
        r.provider_key,
        r.provider_code === 'A940000101' ? 'mirror' : 'primary',
      ]);
    }
  });

  it('has a twin for each quantity that FR-1 registers for the station, and only those', () => {
    for (const code of FR3) {
      const quantities = (of: PublicStation[]) => of.filter((r) => r.provider_code === code).map((r) => r.quantity);
      expect([code, quantities(fr3)]).toEqual([code, quantities(fr1)]);
    }
    // Strasbourg, Metz, Charleville and Hanweiler state a stage only.
    expect(fr3.filter((r) => r.provider_code === 'A743061001').map((r) => r.quantity)).toEqual(['H']);
  });
});

describe('scripts/gen-fr1-stations.ts --series', () => {
  const tsv = (lines: string[]) => `${lines.join('\n')}\n`;
  const at = (minutes: number) =>
    new Date(Date.UTC(2026, 8, 29, 12, 0) + minutes * 60_000).toISOString().replace('.000', '');
  const line = (code: string, quantity: string, minutes: number) => `${code}\t${quantity}\t${at(minutes)}`;
  /** An FR-1 observation page (JSON), as the recorder archives it. */
  const page = (rows: [string | null, string, number][]) =>
    JSON.stringify({
      count: rows.length,
      next: null,
      data: rows.map(([code, quantity, minutes]) => ({
        code_station: code,
        grandeur_hydro: quantity,
        date_obs: at(minutes),
        resultat_obs: 1,
      })),
    });
  const SHA = 'ab'.repeat(32);
  const rec = (text: string, name = 'x.tsv') => ({ name, sha256: SHA, text });
  const csvRows = (text: string) =>
    text
      .split('\n')
      .filter((l) => !l.startsWith('#') && l !== '' && !l.startsWith('code_station'))
      .map((l) => l.split(','));

  it('takes the modal gap as the native step: a tie takes the smaller gap, a repeated timestamp counts once', () => {
    const text = deriveSeries([
      rec(
        tsv([
          // 5, 5, 10 -> 5 min
          ...[0, 5, 10, 20].map((m) => line('A000000001', 'H', m)),
          // 10, 10, 5, 5: a tie between 5 and 10 -> 5 min
          ...[0, 10, 20, 25, 30].map((m) => line('A000000002', 'H', m)),
          // a repeated timestamp is one point: 15, 15
          ...[0, 0, 15, 30].map((m) => line('A000000003', 'Q', m)),
          // 1 h
          ...[0, 60, 120].map((m) => line('A000000004', 'H', m)),
        ]),
      ),
    ]);
    expect(csvRows(text)).toEqual([
      ['A000000001', 'H', 'PT5M', '4'],
      ['A000000002', 'H', 'PT5M', '5'],
      ['A000000003', 'Q', 'PT15M', '3'],
      ['A000000004', 'H', 'PT1H', '3'],
    ]);
  });

  it('leaves out the gaps above an hour: an outage is no step, and points far apart leave PT1H by rule', () => {
    const text = deriveSeries([
      rec(
        tsv([
          ...[0, 5, 10, 300].map((m) => line('A000000001', 'H', m)), // 5, 5, 290 -> 5 min
          ...[0, 270].map((m) => line('A000000002', 'Q', m)), // 270 only -> by rule
        ]),
      ),
    ]);
    expect(csvRows(text)).toEqual([
      ['A000000001', 'H', 'PT5M', '4'],
      ['A000000002', 'Q', 'PT1H', '2'],
    ]);
    expect(text).toContain(
      '# step PT1H by rule (one point, no gap of an hour or less, or fewer than 12 irregular points): A000000002/Q',
    );
  });

  it('takes the union of the recordings (TSV and FR-1 JSON pages) and skips the rows without a code_station', () => {
    const text = deriveSeries([
      rec(tsv([line('B000000001', 'H', 0), line('B000000001', 'H', 10)]), 'a.tsv'),
      rec(
        page([
          ['B000000001', 'H', 20],
          ['B000000001', 'H', 30],
          [null, 'H', 40], // a site-level series
          ['B000000002', 'Q', 0],
        ]),
        'page.raw',
      ),
    ]);
    expect(csvRows(text)).toEqual([
      ['B000000001', 'H', 'PT10M', '4'],
      ['B000000002', 'Q', 'PT1H', '1'],
    ]);
  });

  it('names every recording and its sha256, one line each, sorts the series and lists the by-rule ones', () => {
    const text = deriveSeries([
      { name: 'fr-1-day.tsv.gz', sha256: SHA, text: tsv([line('B000000002', 'Q', 0), line('B000000002', 'H', 0)]) },
      {
        name: 'fr-1-obs.raw',
        sha256: 'cd'.repeat(32),
        text: page([
          ['B000000001', 'H', 0],
          ['B000000001', 'H', 10],
        ]),
      },
    ]);
    const lines = text.split('\n');
    expect(lines.slice(0, 5)).toEqual([
      `# derived by scripts/gen-fr1-stations.ts --series from fr-1-day.tsv.gz sha256 ${SHA}`,
      `# derived by scripts/gen-fr1-stations.ts --series from fr-1-obs.raw sha256 ${'cd'.repeat(32)}`,
      '# step PT1H by rule (one point, no gap of an hour or less, or fewer than 12 irregular points): B000000002/H,',
      '#   B000000002/Q',
      'code_station,quantity,native_step,points',
    ]);
    expect(csvRows(text)).toEqual([
      ['B000000001', 'H', 'PT10M', '2'],
      ['B000000002', 'H', 'PT1H', '1'],
      ['B000000002', 'Q', 'PT1H', '1'],
    ]);
  });

  it('gives a sparse series (fewer than 12 points) whose modal gap is no known step PT1H by rule, and keeps a known step', () => {
    const text = deriveSeries([
      rec(
        tsv([
          // six off-grid points, modal gap 45 min (as A664031003 H in a day): event-driven, by rule
          ...[0, 45, 90, 135, 180, 225].map((m) => line('C000000001', 'H', m)),
          // three points 7 min apart: sparse, unknown step, by rule
          ...[0, 7, 14].map((m) => line('C000000002', 'Q', m)),
          // three points 10 min apart: sparse but a known step
          ...[0, 10, 20].map((m) => line('C000000003', 'Q', m)),
        ]),
      ),
    ]);
    expect(csvRows(text)).toEqual([
      ['C000000001', 'H', 'PT1H', '6'],
      ['C000000002', 'Q', 'PT1H', '3'],
      ['C000000003', 'Q', 'PT10M', '3'],
    ]);
    const listed = text.replace(/\n#\s+/g, ' ');
    expect(listed).toContain('irregular points): C000000001/H, C000000002/Q\n');
    expect(listed).not.toContain('C000000003/Q');
  });

  it('fails on a dense series (12 points or more) with a step outside the allowed set, naming every such series', () => {
    const dense = (code: string, quantity: string, gap: number) =>
      Array.from({ length: 12 }, (_, i) => line(code, quantity, i * gap));
    expect(() =>
      deriveSeries([
        rec(tsv([...dense('C000000001', 'H', 7), ...dense('C000000002', 'Q', 45), ...dense('C000000003', 'H', 5)])),
      ]),
    ).toThrow(/series with a step outside PT5M, PT6M.*: C000000001\/H \(7 min\), C000000002\/Q \(45 min\)$/);
    // Eleven points are still sparse, twelve are dense.
    const points = (n: number) => tsv(Array.from({ length: n }, (_, i) => line('C000000009', 'H', i * 7)));
    expect(csvRows(deriveSeries([rec(points(11))]))).toEqual([['C000000009', 'H', 'PT1H', '11']]);
    expect(() => deriveSeries([rec(points(12))])).toThrow(/C000000009\/H \(7 min\)/);
  });

  it('fails on a malformed line or row, a bad quantity or instant, bad JSON or an empty input', () => {
    for (const bad of [
      'A000000001\tH',
      'A000000001\tH\t2026-09-29T12:00:00Z\textra',
      'A000000001\tX\t2026-09-29T12:00:00Z',
      'A000000001\tH\t2026-09-29 12:00:00',
      'A000000001\tH\t2026-13-45T12:00:00Z',
      'a00\tH\t2026-09-29T12:00:00Z',
      '',
    ]) {
      expect(() => deriveSeries([rec(tsv(['A000000009\tH\t2026-09-29T12:00:00Z', bad]))])).toThrow(
        /series input x\.tsv line 2/,
      );
    }
    const bad = JSON.stringify({
      data: [
        { code_station: 'A000000001', grandeur_hydro: 'H', date_obs: at(0) },
        { code_station: 'A000000001', grandeur_hydro: 'W', date_obs: at(0) },
      ],
    });
    expect(() => deriveSeries([rec(bad, 'p.raw')])).toThrow(/series input p\.raw\.data\[1\]/);
    expect(() => deriveSeries([rec('{"data": [', 'p.raw')])).toThrow(/series input p\.raw: not JSON/);
    expect(() => deriveSeries([rec('{"count": 1}', 'p.raw')])).toThrow(/series input p\.raw\.data: expected an array/);
    expect(() => deriveSeries([rec('')])).toThrow(/no observation/);
  });

  it('reads plain and gzip files (told by the magic bytes, several at once), with the sha256 of the bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr1-series-'));
    try {
      const body = tsv([line('D000000001', 'H', 0), line('D000000001', 'H', 10), line('D000000001', 'H', 20)]);
      const json = page([['D000000002', 'Q', 0]]);
      writeFileSync(join(dir, 'a.tsv'), body);
      writeFileSync(join(dir, 'b.tsv.gz'), gzipSync(body));
      writeFileSync(join(dir, 'c.tsv'), gzipSync(body)); // the extension does not decide
      writeFileSync(join(dir, 'p.raw'), json);
      const plain = deriveSeriesFiles([join(dir, 'a.tsv')]);
      expect(csvRows(plain)).toEqual([['D000000001', 'H', 'PT10M', '3']]);
      expect(csvRows(deriveSeriesFiles([join(dir, 'b.tsv.gz')]))).toEqual(csvRows(plain));
      expect(csvRows(deriveSeriesFiles([join(dir, 'c.tsv')]))).toEqual(csvRows(plain));
      const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
      const both = deriveSeriesFiles([join(dir, 'b.tsv.gz'), join(dir, 'p.raw')]);
      expect(both.split('\n').slice(0, 2)).toEqual([
        `# derived by scripts/gen-fr1-stations.ts --series from b.tsv.gz sha256 ${sha(gzipSync(body))}`,
        `# derived by scripts/gen-fr1-stations.ts --series from p.raw sha256 ${sha(Buffer.from(json))}`,
      ]);
      expect(csvRows(both)).toEqual([
        ['D000000001', 'H', 'PT10M', '3'],
        ['D000000002', 'Q', 'PT1H', '1'],
      ]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  describe('registry/seed/fr-1-series.csv', () => {
    const text = readFileSync(`${repoRoot}registry/seed/fr-1-series.csv`, 'utf8');
    const FIXTURES = ['fr-1-obs.raw', 'fr-1-obs-page1.raw', 'fr-1-obs-page2.raw'];
    const dir = `${repoRoot}apps/server/src/adapters/fr-1/fixtures/`;
    const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const sourceSha = (meta: string) =>
      (JSON.parse(readFileSync(dir + meta, 'utf8')) as { source_sha256: string }).source_sha256;

    it('names its recordings with their sha256: the day export, fr-1-obs.raw and the two full exported seed pages', () => {
      const lines = text.split('\n').filter((l) => l.startsWith('# derived by'));
      expect(lines).toHaveLength(4);
      // The day export is not committed (an archive export): pinned by pattern.
      expect(lines[0]).toMatch(
        /^# derived by scripts\/gen-fr1-stations\.ts --series from fr-1-day\.tsv\.gz sha256 [0-9a-f]{64}$/,
      );
      // fr-1-obs.raw is committed whole: its sha256 is the file's.
      expect(lines[1]).toBe(
        `# derived by scripts/gen-fr1-stations.ts --series from fr-1-obs.raw sha256 ${sha256(`${dir}fr-1-obs.raw`)}`,
      );
      // The two seed pages are exported whole (20,000 rows each) and committed trimmed: their sha256 is the
      // source_sha256 of the fixtures' meta files, which ties the derivation to the archived objects.
      expect(lines[2]).toBe(
        `# derived by scripts/gen-fr1-stations.ts --series from fr-1-page1.raw sha256 ${sourceSha('fr-1-obs-page1.meta.json')}`,
      );
      expect(lines[3]).toBe(
        `# derived by scripts/gen-fr1-stations.ts --series from fr-1-page2.raw sha256 ${sourceSha('fr-1-obs-page2.meta.json')}`,
      );
      expect(sourceSha('fr-1-obs-page1.meta.json')).not.toBe(sourceSha('fr-1-obs-page2.meta.json'));
    });

    it('lists the three series that stay PT1H by rule: sparse and irregular, in the header', () => {
      const flat = text.replace(/\n#\s+/g, ' ');
      expect(flat).toContain(
        'step PT1H by rule (one point, no gap of an hour or less, or fewer than 12 irregular points): A352000101/H, A664031003/H, A903000101/H',
      );
      const rows = csvRows(text);
      for (const key of ['A352000101/H', 'A664031003/H', 'A903000101/H']) {
        const row = rows.find((r) => `${r[0]}/${r[1]}` === key);
        expect([key, row?.[2], Number(row?.[3]) < 12]).toEqual([key, 'PT1H', true]);
      }
    });

    it('holds 550 series, sorted, with the allowed steps', () => {
      const rows = csvRows(text);
      expect(rows).toHaveLength(550);
      const keys = rows.map((r) => `${r[0]}/${r[1] === 'H' ? 0 : 1}`);
      expect(keys).toEqual([...keys].sort());
      expect(new Set(rows.map((r) => r[2]))).toEqual(new Set(['PT5M', 'PT6M', 'PT10M', 'PT15M', 'PT1H']));
      expect(rows.every((r) => Number(r[3]) >= 1)).toBe(true);
    });

    it('covers every code_station and grandeur of the three recorded observation pages, and each is registered', () => {
      const keys = new Set<string>();
      for (const name of FIXTURES) {
        const { data } = JSON.parse(readFileSync(dir + name, 'utf8')) as {
          data: { code_station: string | null; grandeur_hydro: string }[];
        };
        for (const row of data) if (row.code_station !== null) keys.add(`${row.code_station}/${row.grandeur_hydro}`);
      }
      expect(keys.size).toBeGreaterThan(300);
      const registered = new Set(fr1.map((r) => r.provider_key));
      expect([...keys].filter((k) => !registered.has(k))).toEqual([]);
      // The series that a single day misses and the 30-day seed has: Basel, partners and the others.
      for (const key of [
        'A021005050/H',
        'A021005050/Q',
        'B400101101/H',
        'D022000301/Q',
        'E310211002/H',
        'E361121001/Q',
      ]) {
        expect(registered.has(key), key).toBe(true);
      }
    });
  });
});

describe('scripts/gen-fr1-stations.ts fails loudly', () => {
  const mutatedRef = (change: (stations: Map<string, Ref>) => void) => {
    const payloads = structuredClone(inputs.ref) as { data: Ref[] }[];
    change(new Map(payloads.flatMap((p) => p.data).map((s): [string, Ref] => [s.code_station, s])));
    return () => run({ ref: payloads });
  };
  const station = (stations: Map<string, Ref>, code: string) => {
    const found = stations.get(code);
    if (found === undefined) throw new Error(`no fixture station ${code}`);
    return found;
  };
  const withSeries =
    (extra: Record<string, string>[], drop: (r: Record<string, string>) => boolean = () => false) =>
    () =>
      run({ series: [...inputs.series.filter((r) => !drop(r)), ...extra] });

  it('on a series whose station is not in the referentiel', () => {
    expect(withSeries([{ code_station: 'A999999999', quantity: 'H', native_step: 'PT10M', points: '5' }])).toThrow(
      /series A999999999\/H: the station is not in the referentiel fixtures/,
    );
  });

  it('on a foreign (99…) station with a series that is neither a partner nor a curated mirror', () => {
    expect(mutatedRef((s) => (station(s, 'A022020001').code_commune_station = '99109'))).toThrow(
      /station A022020001: a foreign \(99…\) station that is neither a partner nor a curated mirror/,
    );
    expect(mutatedRef((s) => (station(s, 'A022020001').code_commune_station = '99137'))).toThrow(
      /station A022020001: unknown foreign commune 99137/,
    );
  });

  it('on a mirror or a partner whose commune no longer fits', () => {
    expect(mutatedRef((s) => (station(s, 'A375005050').code_commune_station = '99131'))).toThrow(
      /mirror A375005050: commune 99131 is not in DE/,
    );
    expect(mutatedRef((s) => (station(s, 'B610000201').code_commune_station = '99109'))).toThrow(
      /partner B610000201: the commune is not 99131/,
    );
  });

  it('on a tier-1 station without a series, and on a curated station that is not in the referentiel', () => {
    expect(withSeries([], (r) => r.code_station === 'B720000001')).toThrow(
      /tier-1 station B720000001 has no series \(add it to NOT_LIVE\?\)/,
    );
    const payloads = structuredClone(inputs.ref) as { data: Ref[] }[];
    for (const p of payloads) p.data = p.data.filter((s) => s.code_station !== 'A375005050');
    expect(() => run({ ref: payloads })).toThrow(/mirror station A375005050 is not in the referentiel fixtures/);
  });

  it('on a station that is in two referentiel payloads', () => {
    const payloads = structuredClone(inputs.ref) as { data: Ref[] }[];
    const [first, second] = payloads;
    const copy = first?.data[0];
    if (first === undefined || second === undefined || copy === undefined) throw new Error('no referentiel payload');
    second.data.push(structuredClone(copy));
    expect(() => run({ ref: payloads })).toThrow(/referentiel [A-Z0-9]+: duplicate station/);
  });

  it('on a name or water name that breaks the label rule', () => {
    expect(mutatedRef((s) => (station(s, 'B720000001').libelle_station = 'x'.repeat(201)))).toThrow(
      /B720000001\.libelle_station: longer than 200 characters/,
    );
    expect(mutatedRef((s) => (station(s, 'B720000001').libelle_station = 'La Meuse‮'))).toThrow(
      /B720000001\.libelle_station: a control or format character/,
    );
    expect(mutatedRef((s) => (station(s, 'B720000001').libelle_cours_eau = 'La\nMeuse'))).toThrow(
      /B720000001\.libelle_cours_eau: a control or format character/,
    );
    expect(mutatedRef((s) => (station(s, 'B720000001').libelle_station = ''))).toThrow(/expected a non-empty string/);
  });

  it('on a step outside the allowed set, an unknown quantity, a duplicate series or bad points in the series list', () => {
    const row = (change: Record<string, string>) => ({
      code_station: 'A022020001',
      quantity: 'H',
      native_step: 'PT10M',
      points: '5',
      ...change,
    });
    const without = (r: Record<string, string>) => r.code_station === 'A022020001' && r.quantity === 'H';
    expect(withSeries([row({ native_step: 'PT7M' })], without)).toThrow(
      /A022020001\/H has the step "PT7M", outside the allowed set/,
    );
    expect(withSeries([row({ quantity: 'W' })], without)).toThrow(/unknown quantity "W"/);
    expect(withSeries([row({ points: '0' })], without)).toThrow(/points is not a positive integer/);
    expect(withSeries([row({})])).toThrow(/duplicate series A022020001\/H/);
  });

  it('on an FR-3 key station that FR-1 does not register', () => {
    expect(() => run({ fr3: [...inputs.fr3, { code: 'E240041201', name: 'Tournai' }] })).toThrow(
      /fr-3\.csv station E240041201 is not registered by FR-1/,
    );
  });
});
