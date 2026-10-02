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
import { scanCsv } from '../packages/core/src/csv.ts';
import {
  generate,
  type Inputs,
  OUTPUT,
  readInputs,
  SAME_GAUGE,
  TIER1,
  TWINS_OUTPUT,
} from '../scripts/gen-be3-stations.ts';
import { repoRoot } from './catalogue.ts';

// registry/stations/be-3.yaml and registry/twins/be-3.yaml are generated (scripts/gen-be3-stations.ts) from the
// identification-only seed registry/seed/be-3-stations.csv and the public rows the twins name. BE-3 is an owner-audience
// source (catalogue §0.8, invariant 11): the rows identify gauges and nothing else.

const committed = readFileSync(OUTPUT, 'utf8');
const committedTwins = readFileSync(TWINS_OUTPUT, 'utf8');
const inputs = readInputs();
const run = (change: Partial<Inputs> = {}) => generate({ ...inputs, ...change });
const generated = run();
const sources = SourcesFile.parse(parse(readFileSync(`${repoRoot}registry/sources.yaml`, 'utf8'))).sources;
const rows = StationsFile.parse(parse(committed)).stations.filter((s) => s.audience === 'owner');
const pairs = TwinsFile.parse(parse(committedTwins)).twins;
const stationOf = (no: string) => rows.filter((r) => r.provider_code === no);
const stationNos = [...new Set(rows.map((r) => r.provider_code))];

/** The seed's operator of every series, keyed `<station_no>/<parameter>`. */
const operatorOf = new Map(inputs.seed.map((s) => [`${s.station_no}/${s.parameter}`, s.operator]));

const PARAMETERS = {
  H: { quantity: 'H', unit: 'm', factor: 100, kind: 'stage' },
  H_sonde: { quantity: 'H', unit: 'm', factor: 100, kind: 'stage' },
  Habs: { quantity: 'H', unit: 'm', factor: 100, kind: 'level' },
  Habs_sonde: { quantity: 'H', unit: 'm', factor: 100, kind: 'level' },
  Q: { quantity: 'Q', unit: 'm³/s', factor: 1, kind: null },
  QADM: { quantity: 'Q', unit: 'm³/s', factor: 1, kind: null },
} as const;
const STEP = { DGH: 'PT5M', DCENN: 'PT10M', EUP: 'PT5M', GIL: 'PT5M' } as const;
const IMPOUNDED_WATERS = [
  'Basse Meuse',
  'Basse Sambre',
  'Haute Meuse (amont Dinant)',
  'Haute Meuse (aval Dinant)',
  'Haute Sambre',
  'Meuse moyenne',
];

describe('registry/stations/be-3.yaml and registry/twins/be-3.yaml', { timeout: 60_000 }, () => {
  it('are exactly what the generator writes from its inputs', () => {
    expect(committed).toBe(generated.stations);
    expect(committedTwins).toBe(generated.twins);
    expect(run().stations).toBe(generated.stations);
  });

  it('validate against the real sources and the registered series, with no problem', () => {
    expect(validateStations(parse(committed), sources).problems).toEqual([]);
    expect(
      validateTwins(parse(committedTwins), [...inputs.publicRows, ...StationsFile.parse(parse(committed)).stations]),
    ).toEqual({ problems: [], twins: pairs });
  });

  it('hold 607 series at 332 stations, one id per station and one key per series', () => {
    expect(rows).toHaveLength(607);
    expect(inputs.seed).toHaveLength(607);
    expect(stationNos).toHaveLength(332);
    expect(committed).toContain('# Rows: 607 series at 332 stations; tier 1: 19 stations.');
    expect(new Set(rows.map((r) => r.provider_key)).size).toBe(607);
    for (const r of rows) expect([r.provider_key, r.id]).toEqual([r.provider_key, `be.spw.${r.provider_code}`]);
  });

  it('keep the source, audience and licence of every row: BE-3, owner, owner-only, not a first release', () => {
    for (const r of rows) {
      expect([r.id, r.provider_key, r.source, r.audience, r.licence_gate, r.first_release, r.country]).toEqual([
        r.id,
        r.provider_key,
        'BE-3',
        'owner',
        'owner-only',
        false,
        'BE',
      ]);
      expect([r.id, r.expected_threshold_source, r.expected_forecast_source]).toEqual([r.id, null, null]);
    }
    expect(committed).not.toMatch(/audience: (public|off)/);
  });

  it('key every row <station_no>/<parameter> with the unit, factor and value kind of its parameter', () => {
    const seen = new Set<string>();
    for (const r of rows) {
      const [no, parameter, ...rest] = r.provider_key.split('/');
      const p = PARAMETERS[parameter as keyof typeof PARAMETERS];
      expect([r.provider_key, no, rest, p === undefined]).toEqual([r.provider_key, r.provider_code, [], false]);
      seen.add(parameter as string);
      expect([r.provider_key, r.quantity, r.native_unit, r.to_canonical, r.value_kind]).toEqual([
        r.provider_key,
        p.quantity,
        p.unit,
        p.factor,
        p.kind,
      ]);
    }
    expect([...seen].sort()).toEqual(Object.keys(PARAMETERS).sort());
  });

  it('carry the native step of the operator (DGH 5 min, DCENN 10 min, QADM hourly) and expect at least 10 minutes', () => {
    for (const r of rows) {
      const operator = operatorOf.get(r.provider_key) as keyof typeof STEP;
      const native = r.provider_key.endsWith('/QADM') ? 'PT1H' : STEP[operator];
      expect([r.provider_key, native === undefined]).toEqual([r.provider_key, false]);
      expect([r.provider_key, r.native_step, r.expected_step, r.staleness_limit]).toEqual([
        r.provider_key,
        native,
        native === 'PT5M' ? 'PT10M' : native,
        native === 'PT1H' ? 'PT3H' : 'PT45M',
      ]);
    }
    const by = (parameter: string, operator: string) =>
      rows.filter((r) => r.provider_key.endsWith(`/${parameter}`) && operatorOf.get(r.provider_key) === operator);
    expect(by('QADM', 'DGH')).toHaveLength(11);
    expect(by('H', 'DCENN').every((r) => r.native_step === 'PT10M')).toBe(true);
    expect(by('H', 'DGH').every((r) => r.native_step === 'PT5M' && r.expected_step === 'PT10M')).toBe(true);
  });

  it('identify the gauge only: no datum, gauge zero or value, and no real value anywhere in the files', () => {
    const shape = Object.keys(OwnerStation.shape).sort();
    for (const r of rows) expect([r.id, Object.keys(r).sort()]).toEqual([r.id, shape]);
    expect(shape).not.toContain('datum');
    expect(shape).not.toContain('gauge_zero');
    expect(committed).not.toMatch(/^\s*(datum|gauge_zero|value|value_m|threshold|forecast):/m);
    for (const canary of CANARY_RENDERINGS) {
      expect(committed).not.toContain(canary);
      expect(committedTwins).not.toContain(canary);
    }
    // The strict schema refuses a datum on an owner row.
    const withDatum = { stations: [{ ...rows[0], datum: 'NAP' }] };
    expect(StationsFile.safeParse(withDatum).success).toBe(false);
  });

  it('keep HASTIERE 8622 and the two Dinant stations (DCENN L8470, DGH 8059) apart: keyed by number, named as published', () => {
    const dgh = stationOf('8059');
    const dcenn = stationOf('L8470');
    const hastiere = stationOf('8622');
    expect(dgh.map((r) => [r.id, r.provider_key, r.name, r.water_name])).toEqual([
      ['be.spw.8059', '8059/H', 'DINANT', 'Haute Meuse (aval Dinant)'],
    ]);
    expect(dcenn.map((r) => [r.id, r.provider_key, r.name, r.water_name])).toEqual([
      ['be.spw.L8470', 'L8470/H', 'Dinant', 'Ruisseau des Fonds de Leffe'],
      ['be.spw.L8470', 'L8470/Q', 'Dinant', 'Ruisseau des Fonds de Leffe'],
    ]);
    expect(hastiere.map((r) => [r.id, r.provider_key, r.name, r.water_name])).toEqual([
      ['be.spw.8622', '8622/H', 'HASTIERE', 'Hermeton'],
      ['be.spw.8622', '8622/Q', 'HASTIERE', 'Hermeton'],
    ]);
    // The two Dinant names are the same word: a join by name would merge two gauges 1.7 km apart on two waters.
    expect(dgh[0]?.name.toLowerCase()).toBe(dcenn[0]?.name.toLowerCase());
    expect(dgh[0]?.lat).not.toBe(dcenn[0]?.lat);
    expect(operatorOf.get('8059/H')).toBe('DGH');
    expect(operatorOf.get('L8470/H')).toBe('DCENN');
    // Every row has the name and position of its own seed row, and no key is a name.
    for (const s of inputs.seed) {
      const r = rows.find((x) => x.provider_key === `${s.station_no}/${s.parameter}`);
      expect([`${s.station_no}/${s.parameter}`, r?.name, r?.lat, r?.lon, r?.water_name]).toEqual([
        `${s.station_no}/${s.parameter}`,
        s.name,
        Number(s.lat),
        Number(s.lon),
        s.water_name === '' ? null : s.water_name,
      ]);
      expect(r?.provider_key.startsWith(`${s.station_no}/`)).toBe(true);
    }
    expect(rows.filter((r) => rows.some((o) => o.provider_key === r.name))).toEqual([]);
  });

  it('mark exactly the 19 stations of TIER1 as tier 1 and every other row as tier 2', () => {
    expect(TIER1.size).toBe(19);
    for (const r of rows) {
      expect([r.provider_key, r.tier]).toEqual([r.provider_key, TIER1.has(r.provider_code) ? 1 : 2]);
    }
    for (const no of TIER1) expect(stationOf(no).length, no).toBeGreaterThan(0);
    expect(new Set(rows.filter((r) => r.tier === 1).map((r) => r.provider_code))).toEqual(TIER1);
    expect(new Set(rows.filter((r) => r.tier === 2).map((r) => r.provider_code)).size).toBe(332 - 19);
  });

  it('flag the navigable Meuse and Sambre impounded (25 stations), and no other station', () => {
    const named = stationNos.filter((no) => /\b(?:meuse|sambre)\b/i.test(stationOf(no)[0]?.water_name ?? ''));
    expect(named).toHaveLength(25);
    for (const r of rows) {
      expect([r.provider_key, r.flags.tidal, r.flags.impounded]).toEqual([
        r.provider_key,
        null,
        named.includes(r.provider_code) ? true : null,
      ]);
    }
    expect([...new Set(rows.filter((r) => r.flags.impounded).map((r) => r.water_name))].sort()).toEqual(
      IMPOUNDED_WATERS,
    );
    // A tributary or a stream that only has the river in the gauge's name is not impounded.
    expect(stationOf('L7241').map((r) => [r.name, r.water_name, r.flags.impounded])).toEqual([
      ['Jemeppe-sur-Sambre', 'Orneau', null],
      ['Jemeppe-sur-Sambre', 'Orneau', null],
    ]);
    expect(stationOf('8702').every((r) => r.flags.impounded === true)).toBe(true);
  });

  it('flag the two dam lakes (operators EUP and GIL) reservoir, absolute level, and no other row', () => {
    const lakes = rows.filter((r) => r.flags.reservoir === true);
    expect(lakes.map((r) => [r.provider_key, r.name, r.value_kind, r.native_unit])).toEqual([
      ['640601/Habs', 'EUPEN LAC 1', 'level', 'm'],
      ['656601/Habs', 'GILEPPE LAC 1', 'level', 'm'],
    ]);
    expect(lakes.map((r) => operatorOf.get(r.provider_key)).sort()).toEqual(['EUP', 'GIL']);
    for (const r of rows.filter((x) => !lakes.includes(x)))
      expect([r.id, 'reservoir' in r.flags]).toEqual([r.id, false]);
  });
});

describe('the SAME_GAUGE twins of registry/twins/be-3.yaml', { timeout: 60_000 }, () => {
  const bySpw = (no: string, quantity: string) => rows.filter((r) => r.provider_code === no && r.quantity === quantity);
  const pairIdOf = (source: string, code: string, quantity: string) =>
    `${code.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${source.toLowerCase().replace('-', '')}-be3-${quantity.toLowerCase()}`;
  const publicOf = (g: (typeof SAME_GAUGE)[number]) =>
    inputs.publicRows.filter(
      (r) =>
        r.source === g.source &&
        r.provider_code === g.code &&
        r.role === 'primary' &&
        (g.quantity === undefined || r.quantity === g.quantity),
    );

  it('keep every public series primary and public, make the SPW series of the same quantity a twin, and pair them with `constant`', () => {
    let expectedPairs = 0;
    for (const g of SAME_GAUGE) {
      const id = `${g.source} ${g.code} ~ BE-3 ${g.spw}`;
      const pub = publicOf(g);
      expect([id, pub.length > 0]).toEqual([id, true]);
      for (const r of pub) {
        expect([id, r.quantity, r.audience, r.role]).toEqual([id, r.quantity, 'public', 'primary']);
        const mates = bySpw(g.spw, r.quantity);
        const mine = pairs.filter((p) => p.a.source === r.source && p.a.provider_key === r.provider_key);
        if (mates.length === 0) {
          // SPW has no series of that quantity at the station: nothing to pair.
          expect([id, r.quantity, mine.length]).toEqual([id, r.quantity, 0]);
          continue;
        }
        expectedPairs += 1;
        expect([id, r.quantity, mates.map((m) => m.role)]).toEqual([id, r.quantity, ['twin']]);
        expect(mine, `${id} ${r.quantity}`).toHaveLength(1);
        expect(mine[0]).toEqual({
          id: pairIdOf(g.source, g.code, r.quantity),
          a: { source: r.source, provider_key: r.provider_key },
          b: { source: 'BE-3', provider_key: mates[0]?.provider_key },
          relation: {
            kind: 'constant',
            tolerance: r.quantity === 'Q' ? 0.01 : 1,
            unit: r.quantity === 'Q' ? 'm³/s' : 'cm',
            min_share: 0.95,
          },
        });
      }
    }
    expect(expectedPairs).toBe(38);
    expect(pairs).toHaveLength(38);
    expect(rows.filter((r) => r.role === 'twin')).toHaveLength(38);
    for (const p of pairs) {
      const b = rows.find((r) => r.provider_key === p.b.provider_key);
      expect([p.id, p.b.source, b?.role, p.relation.kind]).toEqual([p.id, 'BE-3', 'twin', 'constant']);
    }
    expect(new Set(pairs.map((p) => p.id)).size).toBe(38);
    expect(pairs.map((p) => p.id)).toEqual(pairs.map((p) => p.id).sort());
  });

  it('cover every one of the 17 FR-1 Belgian partners operated by SPW (§0.6), and not Menen (Flemish)', () => {
    const { rows: partners } = scanCsv(readFileSync(`${repoRoot}registry/seed/fr-1-be.csv`, 'utf8'), {
      delimiter: ',',
      commentPrefix: '#',
    });
    const codes = partners.map((r) => r[0] as string);
    expect(codes).toHaveLength(18);
    expect(codes).toContain('E381126601');
    const spw = codes.filter((c) => c !== 'E381126601');
    expect(spw).toHaveLength(17);
    const named = SAME_GAUGE.filter((g) => g.source === 'FR-1').map((g) => g.code);
    for (const code of spw) {
      expect([code, named.includes(code)]).toEqual([code, true]);
      expect([code, pairs.some((p) => p.a.source === 'FR-1' && p.a.provider_key.startsWith(`${code}/`))]).toEqual([
        code,
        true,
      ]);
    }
    expect(named).not.toContain('E381126601');
    expect(pairs.filter((p) => p.a.provider_key.startsWith('E381126601'))).toEqual([]);
  });

  it('pair the two RWS series of Lixhe Aval and the Eijsden-grens discharge (the wider 300 m bound) with SPW 5436', () => {
    expect(SAME_GAUGE.filter((g) => g.source === 'NL-1').map((g) => [g.code, g.spw, g.quantity, g.within])).toEqual([
      ['lixhebiefaval', '5436', undefined, undefined],
      ['eijsden.grens', '5436', 'Q', 300],
    ]);
    expect(
      pairs
        .filter((p) => p.a.source === 'NL-1')
        .map((p) => [p.id, p.b.provider_key])
        .sort(),
    ).toEqual([
      ['eijsden-grens-nl1-be3-q', '5436/Q'],
      ['lixhebiefaval-nl1-be3-h', '5436/H'],
    ]);
  });
});

describe('scripts/gen-be3-stations.ts fails loudly', { timeout: 60_000 }, () => {
  const seed = (change: (s: Inputs['seed']) => Inputs['seed']) => ({ seed: change([...inputs.seed]) });
  const bergiers = (change: (r: Inputs['seed'][number]) => Inputs['seed'][number], parameter = 'H') =>
    seed((s) => s.map((r) => (r.station_no === '1046' && r.parameter === parameter ? change(r) : r)));
  const moved = (source: string, code: string, dLat: number) => ({
    publicRows: inputs.publicRows.map((r) =>
      r.source === source && r.provider_code === code ? { ...r, lat: (r.lat ?? 0) + dLat } : r,
    ),
  });

  it('on a parameter or an operator outside its tables', () => {
    expect(() => run(bergiers((r) => ({ ...r, parameter: 'Hx' })))).toThrow(
      /1046: parameter Hx is not registered \(a reviewed decision\)/,
    );
    expect(() => run(bergiers((r) => ({ ...r, operator: 'XYZ' })))).toThrow(/1046: operator XYZ unknown/);
  });

  it('on a unit that does not match the parameter', () => {
    expect(() => run(bergiers((r) => ({ ...r, unit: 'cm' })))).toThrow(/1046\/H: unit cm is not m/);
    expect(() => run(bergiers((r) => ({ ...r, unit: 'm' }), 'Q'))).toThrow(/1046\/Q: unit m is not m³\/s/);
    expect(() => run(bergiers((r) => ({ ...r, unit: 'cumec' }), 'Q'))).not.toThrow();
  });

  it('on a station whose rows disagree on name, position or water', () => {
    const change = { name: 'OTHER', lat: '50.7', lon: '4.6', water_name: 'Senne' } as const;
    for (const [field, value] of Object.entries(change)) {
      expect(() => run(bergiers((r) => ({ ...r, [field]: value }), 'Q')), field).toThrow(
        /1046: its series disagree on name, position or water/,
      );
    }
  });

  it('on a TIER1 number that the list does not have', () => {
    expect(() => run(seed((s) => s.filter((r) => r.station_no !== '8702')))).toThrow(/TIER1 8702: not in the groups/);
  });

  it('on a SAME_GAUGE pair more than its distance apart, and on a public row that is missing', () => {
    expect(() => run(moved('FR-1', 'B400101101', 0.01))).toThrow(
      /SAME_GAUGE FR-1 B400101101 ~ L6023: more than 100 m apart/,
    );
    expect(() => run(moved('NL-1', 'lixhebiefaval', 0.01))).toThrow(
      /SAME_GAUGE NL-1 lixhebiefaval ~ 5436: more than 100 m apart/,
    );
    expect(() => run(moved('NL-1', 'eijsden.grens', 0.01))).toThrow(
      /SAME_GAUGE NL-1 eijsden\.grens ~ 5436: more than 300 m apart/,
    );
    expect(() =>
      run({ publicRows: inputs.publicRows.filter((r) => !(r.source === 'FR-1' && r.provider_code === 'B400101101')) }),
    ).toThrow(/SAME_GAUGE FR-1 B400101101 ~ L6023: missing/);
  });
});
