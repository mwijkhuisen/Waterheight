import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  CANARY_RENDERINGS,
  OwnerStation,
  SourcesFile,
  StationsFile,
  TwinsFile,
  validateStations,
  validateTwins,
} from '../packages/contracts/src/index.ts';
import {
  generate,
  type Inputs,
  norm,
  OUTPUT,
  readInputs,
  seedLine,
  TS_PATH,
  TWINS_OUTPUT,
} from '../scripts/gen-lu2-stations.ts';
import { repoRoot } from './catalogue.ts';

// registry/stations/lu-2.yaml and registry/twins/lu-2.yaml are generated (scripts/gen-lu2-stations.ts) from the AGE
// per-station JSON seed (registry/seed/lu-2.csv: each file's ts_path and unit) and the LU-1 rows of the same gauges.
// LU-2 is an owner-audience twin of LU-1 in both audiences, never primary (A§7.2); its rows identify the gauge only.

const committed = readFileSync(OUTPUT, 'utf8');
const committedTwins = readFileSync(TWINS_OUTPUT, 'utf8');
const inputs = readInputs();
const run = (change: Partial<Inputs> = {}) => generate({ ...inputs, ...change });
const sources = SourcesFile.parse(parse(readFileSync(`${repoRoot}registry/sources.yaml`, 'utf8'))).sources;
const all = StationsFile.parse(parse(committed)).stations;
const rows = all.filter((s) => s.audience === 'owner');
const pairs = TwinsFile.parse(parse(committedTwins)).twins;
const lu1Of = (slug: string) => inputs.lu1.filter((r) => r.id === `lu.age.${slug}`);
const slugOf = (id: string) => id.slice('lu.age-json.'.length);
// The gauges AGE does not serve as a file: SN_Remich (404), and the two LfU RLP gauges (catalogue §0.8).
const NOT_FETCHED = ['Bollendorf', 'Gemünd_Our', 'SN_Remich'];

describe('registry/stations/lu-2.yaml and registry/twins/lu-2.yaml', { timeout: 30_000 }, () => {
  it('are exactly what the generator writes from its inputs', () => {
    const generated = run();
    expect(committed).toBe(generated.stations);
    expect(committedTwins).toBe(generated.twins);
    expect(run().stations).toBe(generated.stations);
  });

  it('validate against the real sources and the registered series, with no problem', () => {
    expect(validateStations(parse(committed), sources).problems).toEqual([]);
    expect(validateTwins(parse(committedTwins), [...inputs.lu1, ...all])).toEqual({ problems: [], twins: pairs });
  });

  it('hold 39 rows: all twins, owner audience, owner-only, tier 2, identification only', () => {
    expect(rows).toHaveLength(39);
    expect(all).toHaveLength(39);
    expect(inputs.seed).toHaveLength(39);
    expect(committed).toContain('# Rows: 39.');
    const shape = Object.keys(OwnerStation.shape).sort();
    for (const r of rows) {
      expect([r.id, r.source, r.role, r.audience, r.licence_gate, r.tier, r.first_release]).toEqual([
        r.id,
        'LU-2',
        'twin',
        'owner',
        'owner-only',
        2,
        false,
      ]);
      expect([r.id, r.quantity, r.native_step, r.expected_step]).toEqual([r.id, 'H', 'PT15M', 'PT15M']);
      expect([r.id, r.expected_threshold_source, r.expected_forecast_source]).toEqual([r.id, null, null]);
      expect([r.id, Object.keys(r).sort()]).toEqual([r.id, shape]);
    }
    expect(committed).not.toMatch(/^\s*(datum|gauge_zero|value|value_m|threshold|forecast):/m);
    expect(committed).not.toMatch(/audience: (public|off)|role: primary/);
    for (const canary of CANARY_RENDERINGS) {
      expect(committed).not.toContain(canary);
      expect(committedTwins).not.toContain(canary);
    }
  });

  it('give every row the id lu.age-json.<LU-1 slug> and the provider_key of the seed ts_path', () => {
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(39);
    expect(new Set(rows.map((r) => r.provider_key)).size).toBe(39);
    for (const r of rows) {
      const files = inputs.seed.filter((s) => s.ts_path === r.provider_key);
      expect([r.id, files.length]).toEqual([r.id, 1]);
      expect([r.id, r.id.startsWith('lu.age-json.')]).toEqual([r.id, true]);
      expect([r.id, r.provider_key]).toEqual([r.id, files[0]?.ts_path]);
    }
  });

  it('join exactly one LU-1 row each, with its name, coordinates and provider_code', () => {
    for (const s of inputs.seed) {
      const matches = inputs.lu1.filter((r) => norm(r.provider_key) === norm(s.file));
      expect([s.file, matches.length]).toEqual([s.file, 1]);
      const row = rows.find((r) => r.provider_key === s.ts_path);
      expect([s.file, row?.id]).toEqual([s.file, `lu.age-json.${matches[0]?.id.slice('lu.age.'.length)}`]);
    }
    for (const r of rows) {
      const lu1 = lu1Of(slugOf(r.id));
      expect([r.id, lu1.length]).toEqual([r.id, 1]);
      expect([r.id, r.name, r.provider_code, r.lon, r.lat, r.country, r.water_name, r.flags]).toEqual([
        r.id,
        lu1[0]?.name,
        lu1[0]?.provider_code,
        lu1[0]?.lon,
        lu1[0]?.lat,
        lu1[0]?.country,
        lu1[0]?.water_name,
        lu1[0]?.flags,
      ]);
      expect([r.id, lu1[0]?.audience]).toEqual([r.id, 'public']);
    }
    expect(new Set(rows.map((r) => slugOf(r.id))).size).toBe(39);
  });

  it('never name Bollendorf, Gemünd_Our (LfU RLP) or SN_Remich (404), and never a withheld LU-1 row', () => {
    for (const name of NOT_FETCHED) {
      expect(rows.filter((r) => r.name === name || r.provider_key === name)).toEqual([]);
      expect(inputs.seed.filter((s) => norm(s.file) === norm(name))).toEqual([]);
      expect(pairs.filter((p) => p.a.provider_key === name)).toEqual([]);
    }
    const off = inputs.lu1.filter((r) => r.audience === 'off').map((r) => r.provider_key);
    expect(off).toEqual(expect.arrayContaining(['Bollendorf', 'Gemünd_Our']));
    for (const name of off) expect(pairs.filter((p) => p.a.provider_key === name)).toEqual([]);
    expect(inputs.lu1.filter((r) => r.provider_key === 'SN_Remich').map((r) => r.audience)).toEqual(['public']);
  });

  it('declare Esch-Sure the one level row in metres (x100) and every other row a stage in cm', () => {
    const esch = rows.find((r) => r.id === 'lu.age-json.esch-sure');
    expect(esch).toMatchObject({
      native_unit: 'm',
      to_canonical: 100,
      value_kind: 'level',
      provider_key: '0/40/W_out_LAC/15m.Cmd.RelAbs.P',
      flags: { tidal: null, impounded: null, reservoir: true },
    });
    expect(inputs.seed.filter((s) => s.unit === 'm').map((s) => s.file)).toEqual(['Esch-Sure']);
    for (const r of rows.filter((x) => x.id !== 'lu.age-json.esch-sure')) {
      expect([r.id, r.native_unit, r.to_canonical, r.value_kind, 'reservoir' in r.flags]).toEqual([
        r.id,
        'cm',
        1,
        'stage',
        false,
      ]);
    }
    expect(inputs.seed.filter((s) => s.unit === 'cm')).toHaveLength(38);
  });

  it('hold 39 pairs, one per row: a the LU-1 series, b the LU-2 series, offset 0 within 0.05 cm for 98 % of the points', () => {
    expect(pairs).toHaveLength(39);
    expect(new Set(pairs.map((p) => p.id)).size).toBe(39);
    expect(pairs.map((p) => p.id)).toEqual(pairs.map((p) => p.id).sort());
    for (const r of rows) {
      const slug = slugOf(r.id);
      const mine = pairs.filter((p) => p.b.provider_key === r.provider_key);
      expect([r.id, mine.length]).toEqual([r.id, 1]);
      expect(mine[0]).toEqual({
        id: `${slug}-lu1-lu2-h`,
        a: { source: 'LU-1', provider_key: lu1Of(slug)[0]?.provider_key },
        b: { source: 'LU-2', provider_key: r.provider_key },
        relation: { kind: 'offset', expected: 0, tolerance: 0.05, unit: 'cm', min_share: 0.98 },
      });
    }
  });
});

describe('scripts/gen-lu2-stations.ts fails loudly', { timeout: 30_000 }, () => {
  const seed = (change: (s: Inputs['seed']) => Inputs['seed']) => ({ seed: change([...inputs.seed]) });
  const file = (name: string, change: (r: Inputs['seed'][number]) => Inputs['seed'][number]) =>
    seed((s) => s.map((r) => (r.file === name ? change(r) : r)));
  const first = inputs.seed[0] as Inputs['seed'][number];

  it('on a file that matches no LU-1 row, and on one that matches two', () => {
    expect(() => run(seed((s) => [...s, { file: 'Neue Station', ts_path: '0/999/x', unit: 'cm' }]))).toThrow(
      /lu-2\.csv Neue Station: matches 0 LU-1 rows, not one/,
    );
    const mersch = inputs.lu1.find((r) => r.provider_key === 'Mersch');
    if (mersch === undefined) throw new Error('no LU-1 row Mersch');
    expect(() => run({ lu1: [...inputs.lu1, { ...mersch, id: 'lu.age.mersch-2' }] })).toThrow(
      /lu-2\.csv Mersch: matches 2 LU-1 rows, not one/,
    );
  });

  it('on a withheld (off) LU-1 row: Bollendorf and Gemünd_Our are never fetched', () => {
    for (const name of ['Bollendorf', 'Gemünd_Our']) {
      expect(() => run(seed((s) => [...s, { file: name, ts_path: '0/999/x', unit: 'cm' }]))).toThrow(
        new RegExp(`lu-2\\.csv ${name}: its LU-1 row is withheld \\(off\\): never fetched`),
      );
    }
  });

  it("on a unit that is not the LU-1 row's kind: a cm Esch-Sure, a metre stage, an unknown unit", () => {
    expect(() => run(file('Esch-Sure', (r) => ({ ...r, unit: 'cm' })))).toThrow(
      /lu-2\.csv Esch-Sure: unit cm is not the LU-1 row's \(m, level\)/,
    );
    expect(() => run(file('Mersch', (r) => ({ ...r, unit: 'm' })))).toThrow(
      /lu-2\.csv Mersch: unit m is not the LU-1 row's \(cm, stage\)/,
    );
    expect(() => run(file('Mersch', (r) => ({ ...r, unit: 'ft' })))).toThrow(
      /lu-2\.csv Mersch: unit ft is not the LU-1 row's/,
    );
    expect(() => run(file('Mersch', (r) => ({ ...r, unit: '' })))).toThrow(/lu-2\.csv Mersch: unit {2}is not/);
  });

  it('on a malformed ts_path, and on one used twice', () => {
    for (const bad of [
      '',
      ' 0/1/x',
      '/0/1/x',
      '.hidden',
      'a b',
      `0/${'x'.repeat(120)}`,
      '0/1/W/15m.Cmd.P,9',
      '0/../15m.Cmd.P',
    ]) {
      expect(() => run(file(first.file, (r) => ({ ...r, ts_path: bad }))), JSON.stringify(bad)).toThrow(
        new RegExp(`lu-2\\.csv ${first.file}: ts_path is missing or malformed`),
      );
    }
    const second = inputs.seed[1] as Inputs['seed'][number];
    expect(() => run(file(second.file, (r) => ({ ...r, ts_path: first.ts_path })))).toThrow(
      new RegExp(`lu-2\\.csv ${second.file}: ts_path twice`),
    );
  });
});

describe('scripts/gen-lu2-stations.ts --extract writes only what its patterns allow (review SR-6)', () => {
  // Invented files in the LU-2 shape: no export is read here.
  const body = (ts_path: string, unit: string) =>
    Buffer.from(
      JSON.stringify([
        {
          ts_path,
          ts_unitsymbol: unit,
          station_name: 'Station',
          parametertype_name: 'W',
          rows: '0',
          columns: 'Timestamp,Value',
          data: [],
        },
      ]),
    );

  it('every committed ts_path matches the pattern, and every unit is cm or m', () => {
    expect(inputs.seed).toHaveLength(39);
    for (const r of inputs.seed)
      expect([r.file, TS_PATH.test(r.ts_path), /^(cm|m)$/.test(r.unit)]).toEqual([r.file, true, true]);
  });

  it('takes a well-formed file, and refuses any other ts_path or unit with a fixed message', () => {
    expect(seedLine('Mersch', body('0/9/W/15m.Cmd.RelAbs.P', 'cm'))).toBe('Mersch,0/9/W/15m.Cmd.RelAbs.P,cm');
    for (const bad of [
      '0/9/W/15m.Cmd.P,x',
      '0/9/W/15m.Cmd.P\nfile',
      '1/9/W/15m.Cmd.P',
      '0/9/W/1h.Cmd.P',
      '0/9 W/15m.Cmd.P',
      '',
    ]) {
      expect(() => seedLine('Mersch', body(bad, 'cm')), JSON.stringify(bad)).toThrow(
        /^Mersch: the export's ts_path does not match the ts_path pattern$/,
      );
    }
    for (const bad of ['mm', 'cm,', 'm ', '', 'CM']) {
      expect(() => seedLine('Mersch', body('0/9/W/15m.Cmd.P', bad)), JSON.stringify(bad)).toThrow(
        /^Mersch: the export's unit is not cm or m$/,
      );
    }
  });
});
