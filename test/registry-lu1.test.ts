import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  audienceWithin,
  type PublicStation,
  SourcesFile,
  StationsFile,
  validateStations,
} from '../packages/contracts/src/index.ts';
import { generate, type Inputs, OUTPUT, readInputs } from '../scripts/gen-lu1-stations.ts';
import { repoRoot } from './catalogue.ts';

// registry/stations/lu-1.yaml is generated (scripts/gen-lu1-stations.ts) from the recorded AGE CSV (names, units) and
// the recorded geoportail.lu points (LU-6: coordinates by fiche code), joined by an explicit curated table: the
// committed file is exactly the generator's output, and it holds what the catalogue (§2.6, §3.2) and the owner
// decisions on the Moselle twins and the LfU RLP gauges say.

const committed = readFileSync(OUTPUT, 'utf8');
const inputs = readInputs();
const run = (change: Partial<Inputs> = {}) => generate({ ...inputs, ...change });
const sources = SourcesFile.parse(parse(readFileSync(`${repoRoot}registry/sources.yaml`, 'utf8'))).sources;
const rows = StationsFile.parse(parse(committed)).stations.filter((s): s is PublicStation => s.audience !== 'owner');
const de1 = (
  parse(readFileSync(`${repoRoot}registry/stations/de-1.yaml`, 'utf8')) as {
    stations: { provider_code: string; role: string; quantity: string }[];
  }
).stations;
const flat = committed.replace(/\n#\s+/g, ' ');
const find = (name: string) => {
  const row = rows.find((r) => r.provider_key === name);
  if (row === undefined) throw new Error(`no LU-1 row ${name}`);
  return row;
};
const csvNames = inputs.table.rows.map((r) => r.name);

// Catalogue §3.2, the bold LU gauges; Bollendorf is tier 1 too but withheld.
const TIER1 = [
  'SN_Remich',
  'SN_Wasserbillig',
  'Bigonville',
  'Wiltz',
  'Clervaux',
  'Mersch',
  'Ettelbrück / Alzette',
  'Diekirch',
  'Vianden',
  'Rosport',
];
const TWINS = [
  ['Perl', '26100100'],
  ['SN_Stadtbredimus', '26100130'],
  ['SN_Grevenmacher', '26100200'],
] as const;
const WITHHELD = ['Bollendorf', 'Gemünd_Our'];
const IMPOUNDED = ['Perl', 'SN_Grevenmacher', 'SN_Remich', 'SN_Stadtbredimus', 'SN_Wasserbillig'];

describe('registry/stations/lu-1.yaml', { timeout: 30_000 }, () => {
  it('is exactly what the generator writes from its inputs', () => {
    expect(committed).toBe(run());
  });

  it('is deterministic: the same input gives the same bytes and no timestamp', () => {
    expect(run()).toBe(run());
    expect(committed.slice(committed.indexOf('\nstations:'))).not.toMatch(/\d{2}:\d{2}/);
  });

  it('is unchanged by a YAML 1.1 reader (fiche codes such as 04 and 00229150 are quoted)', () => {
    expect(parse(committed, { version: '1.1' })).toEqual(parse(committed));
    expect(find('Steinsel').provider_code).toBe('04');
    expect(find('SN_Remich').provider_code).toBe('00229150');
  });

  it('validates against the real sources with no problem', () => {
    expect(validateStations(parse(committed), sources).problems).toEqual([]);
  });

  it('names its two inputs with recorded_at and sha256 in the header', () => {
    expect(inputs.files.map((f) => f.path)).toEqual([
      'apps/server/src/adapters/lu-1/fixtures/lu-1-csv.raw',
      'apps/server/src/adapters/lu-6/fixtures/lu-6-geo.raw',
    ]);
    for (const f of inputs.files) {
      expect(committed).toContain(`${f.path}  recorded_at ${f.recorded_at}  sha256 ${f.sha256}`);
    }
  });

  it('holds one H row per CSV row (42), named exactly as the CSV names it, ordered by id', () => {
    expect(csvNames).toHaveLength(42);
    expect(rows).toHaveLength(42);
    expect(rows.map((r) => r.provider_key).sort()).toEqual([...csvNames].sort());
    expect(rows.map((r) => r.name)).toEqual(rows.map((r) => r.provider_key));
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
    for (const r of rows) {
      expect(r).toMatchObject({
        id: `lu.age.${r.id.slice('lu.age.'.length)}`,
        source: 'LU-1',
        water_name: null,
        quantity: 'H',
        river: null,
        km: null,
        native_step: 'PT15M',
        expected_step: 'PT15M',
        staleness_limit: 'PT90M',
        expected_threshold_source: null,
        expected_forecast_source: null,
        gauge_zero: [],
      });
      expect(r.flags.tidal).toBeNull();
    }
    expect(find('Ettelbrück / Alzette').id).toBe('lu.age.ettelbruck-alzette');
    expect(find('Gemünd_Our').id).toBe('lu.age.gemund-our');
    expect(find('SN_Wasserbillig').id).toBe('lu.age.wasserbillig');
  });

  it('takes the position of every row from its LU-6 fiche, none for Perl; the two Kautenbach and Niederfeulen are told apart by code', () => {
    const byCode = new Map(inputs.fiches.map((f) => [f.code, f]));
    for (const r of rows.filter((x) => x.provider_key !== 'Perl')) {
      const f = byCode.get(r.provider_code);
      expect([r.id, r.lon, r.lat]).toEqual([r.id, f?.lon, f?.lat]);
    }
    expect(find('Perl')).toMatchObject({ provider_code: '26100100', lon: null, lat: null, country: 'DE' });
    expect(find('Kautenbach').provider_code).toBe('14');
    expect(find('Niederfeulen').provider_code).toBe('27');
    expect(find('Gemünd_Our').provider_code).toBe('2626030300');
    expect(inputs.fiches.filter((f) => f.name === 'Kautenbach').map((f) => f.code)).toEqual(['14', '104']);
    expect(inputs.fiches.filter((f) => f.name === 'Niederfeulen').map((f) => f.code)).toEqual(['27', '77']);
  });

  it('marks the ten bold gauges of catalogue §3.2 as tier 1 and first_release; Bollendorf is tier 1 but not first release', () => {
    const tier1 = rows.filter((r) => r.tier === 1);
    expect(tier1.map((r) => r.provider_key).sort()).toEqual([...TIER1, 'Bollendorf'].sort());
    expect(
      tier1
        .filter((r) => r.first_release)
        .map((r) => r.provider_key)
        .sort(),
    ).toEqual([...TIER1].sort());
    expect(tier1.every((r) => r.role === 'primary')).toBe(true);
    expect(rows.filter((r) => r.tier === 2).every((r) => !r.first_release)).toBe(true);
    expect(rows.filter((r) => r.tier === 2)).toHaveLength(31);
  });

  it('declares Perl, SN_Stadtbredimus and SN_Grevenmacher twins (tier 2) of the DE-1 primary stage rows of the same gauge', () => {
    expect(
      rows
        .filter((r) => r.role === 'twin')
        .map((r) => r.provider_key)
        .sort(),
    ).toEqual(TWINS.map(([name]) => name).sort());
    for (const [name, code] of TWINS) {
      expect(find(name)).toMatchObject({ role: 'twin', tier: 2, first_release: false, audience: 'public' });
      expect(de1.filter((s) => s.provider_code === code && s.quantity === 'H').map((s) => s.role)).toEqual(['primary']);
    }
    expect(flat).toContain('Owner decision 2026-10-02: DE-1 stays primary, the LU-1 copy is a twin');
    // The other Moselle gauges (Remich, Wasserbillig) have no DE-1 copy: primary.
    expect(find('SN_Remich').role).toBe('primary');
    expect(find('SN_Wasserbillig').role).toBe('primary');
  });

  it('withholds the two LfU RLP gauges (audience off, licence_gate withheld, not first release); every other row is public and open', () => {
    for (const r of rows) {
      const withheld = WITHHELD.includes(r.provider_key);
      expect([r.id, r.audience, r.licence_gate]).toEqual([
        r.id,
        withheld ? 'off' : 'public',
        withheld ? 'withheld' : 'open',
      ]);
      if (withheld) expect([r.first_release, r.country]).toEqual([false, 'DE']);
    }
    expect(find('Bollendorf').tier).toBe(1);
  });

  it('maps every LU-1 series override of registry/sources.yaml to the row lu.age.<key>, at least as narrow as the override', () => {
    const lu1 = sources.find((s) => s.id === 'LU-1');
    expect(lu1?.series.map((o) => o.key)).toEqual(['bollendorf', 'gemund-our']);
    for (const o of lu1?.series ?? []) {
      const row = rows.find((r) => r.id === `lu.age.${o.key}`);
      expect(row, o.key).toBeDefined();
      expect(audienceWithin(row?.audience ?? 'public', o.audience ?? 'public'), o.key).toBe(true);
    }
  });

  it('declares Esch-Sure the reservoir: metres NN x100, an absolute level (NG95); every other row is cm, stage, LOCAL, with no reservoir key', () => {
    expect(find('Esch-Sure')).toMatchObject({
      native_unit: 'm',
      to_canonical: 100,
      value_kind: 'level',
      datum: 'NG95',
      flags: { tidal: null, impounded: null, reservoir: true },
    });
    for (const r of rows.filter((x) => x.provider_key !== 'Esch-Sure')) {
      expect([r.id, r.native_unit, r.to_canonical, r.value_kind, r.datum, 'reservoir' in r.flags]).toEqual([
        r.id,
        'cm',
        1,
        'stage',
        'LOCAL',
        false,
      ]);
    }
    expect(inputs.table.rows.find((r) => r.name === 'Esch-Sure')?.unit).toBe('m');
  });

  it('puts the impounded Moselle on flags.impounded (Perl and the four SN_ gauges); country DE for Perl, Bollendorf and Gemünd_Our', () => {
    expect(
      rows
        .filter((r) => r.flags.impounded === true)
        .map((r) => r.provider_key)
        .sort(),
    ).toEqual(IMPOUNDED);
    expect(rows.filter((r) => r.flags.impounded !== true).every((r) => r.flags.impounded === null)).toBe(true);
    expect(
      rows
        .filter((r) => r.country === 'DE')
        .map((r) => r.provider_key)
        .sort(),
    ).toEqual(['Bollendorf', 'Gemünd_Our', 'Perl']);
    expect(rows.filter((r) => r.country === 'LU')).toHaveLength(39);
  });

  it('lists the Service de la navigation gauges as a [U] item (C4) in the header', () => {
    expect(flat).toContain('[U] The Service de la navigation gauges');
    for (const n of ['SN_Remich', 'SN_Wasserbillig']) expect(flat).toContain(n);
    expect(flat).toContain('whether that covers them is unverified (C4)');
  });
});

describe('scripts/gen-lu1-stations.ts fails loudly', { timeout: 30_000 }, () => {
  const rowsOf = (change: (r: Inputs['table']['rows']) => Inputs['table']['rows']) => ({
    table: { ...inputs.table, rows: change([...inputs.table.rows]) },
  });
  const fiches = (change: (f: Inputs['fiches']) => Inputs['fiches']) => ({ fiches: change([...inputs.fiches]) });

  it('on a CSV name that is not in the curated table, and on a table name that the CSV no longer has', () => {
    const first = inputs.table.rows[0];
    if (first === undefined) throw new Error('no CSV row');
    expect(() => run(rowsOf((r) => [...r, { ...first, name: 'Neue Station' }]))).toThrow(
      /CSV names that are not in the curated table: Neue Station/,
    );
    expect(() => run(rowsOf((r) => r.filter((x) => x.name !== 'Mersch')))).toThrow(
      /curated table names that are not in the CSV: Mersch/,
    );
    expect(() => run(rowsOf((r) => [...r, first]))).toThrow(/the CSV has Heiderscheidergrund twice/);
  });

  it('on a fiche code that LU-6 does not have, has twice or has out of service', () => {
    expect(() => run(fiches((f) => f.filter((x) => x.code !== '42')))).toThrow(
      /station Ettelbrück \/ Alzette: the fiche 42 is not in LU-6/,
    );
    const mersch = inputs.fiches.find((f) => f.code === '07');
    if (mersch === undefined) throw new Error('no LU-6 fiche 07');
    expect(() => run(fiches((f) => [...f, mersch]))).toThrow(/station Mersch: the fiche 07 is in LU-6 2 times/);
    expect(() => run(fiches((f) => f.map((x) => (x.code === '07' ? { ...x, inService: false } : x))))).toThrow(
      /station Mersch: the fiche 07 is out of service in LU-6/,
    );
  });

  it("on a unit that is not the table's: a cm row in metres, and the reservoir in cm", () => {
    expect(() => run(rowsOf((r) => r.map((x) => (x.name === 'Mersch' ? { ...x, unit: 'm' } : x))))).toThrow(
      /station Mersch: the CSV unit is "m"/,
    );
    expect(() => run(rowsOf((r) => r.map((x) => (x.name === 'Esch-Sure' ? { ...x, unit: 'cm' } : x))))).toThrow(
      /station Esch-Sure: the CSV unit is "cm"/,
    );
  });

  it('on a twin whose DE-1 gauge is missing, not primary or not a stage row', () => {
    const without = (code: string) => ({ de1: inputs.de1.filter((r) => r.provider_code !== code) });
    expect(() => run(without('26100100'))).toThrow(
      /station Perl: the DE-1 gauge 26100100 is not exactly one primary stage row/,
    );
    expect(() =>
      run({ de1: inputs.de1.map((r) => (r.provider_code === '26100130' ? { ...r, role: 'mirror' } : r)) }),
    ).toThrow(/station SN_Stadtbredimus: the DE-1 gauge 26100130 is not exactly one primary stage row/);
    expect(() =>
      run({ de1: inputs.de1.map((r) => (r.provider_code === '26100200' ? { ...r, value_kind: 'level' } : r)) }),
    ).toThrow(/station SN_Grevenmacher: the DE-1 gauge 26100200 is not exactly one primary stage row/);
  });
});
