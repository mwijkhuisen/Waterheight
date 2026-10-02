import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type PublicStation, SourcesFile, StationsFile, validateStations } from '../packages/contracts/src/index.ts';
import { scanCsv } from '../packages/core/src/csv.ts';
import {
  deriveSteps,
  deriveStepsFile,
  generate,
  type Inputs,
  OUTPUT_CH1,
  OUTPUT_CH2,
  readInputs,
} from '../scripts/gen-ch1-stations.ts';
import { repoRoot } from './catalogue.ts';

// registry/stations/ch-1.yaml and ch-2.yaml are generated (scripts/gen-ch1-stations.ts) from the recorded
// LINDAS river and lake cubes, the recorded hydrodaten GeoJSON, the BAFU forecast stations and the steps table
// derived from one UTC day of payloads: the committed files are exactly the generator's output, and they hold
// what the catalogue (§3.1, §2.7) and the owner decision on scope (Q2) say.

const committed = { ch1: readFileSync(OUTPUT_CH1, 'utf8'), ch2: readFileSync(OUTPUT_CH2, 'utf8') };
const inputs = readInputs();
const run = (change: Partial<Inputs> = {}) => generate({ ...inputs, ...change });
const sources = SourcesFile.parse(parse(readFileSync(`${repoRoot}registry/sources.yaml`, 'utf8'))).sources;
const rowsOf = (text: string) =>
  StationsFile.parse(parse(text)).stations.filter((s): s is PublicStation => s.audience !== 'owner');
const ch1 = rowsOf(committed.ch1);
const ch2 = rowsOf(committed.ch2);
const stationIds = (of: PublicStation[]) => new Set(of.map((r) => r.id));
const codes = (of: PublicStation[]) => [...new Set(of.map((r) => r.provider_code))].sort();
const find = (of: PublicStation[], code: string, quantity: 'H' | 'Q' = 'H') => {
  const row = of.find((r) => r.provider_code === code && r.quantity === quantity);
  if (row === undefined) throw new Error(`no row ${code} ${quantity}`);
  return row;
};

// The cubes, read independently of the generator: header, columns id name water time q w t dl wkt.
const cube = (text: string) => scanCsv(text, { delimiter: ',', extraField: false });
type Obs = { id: string; name: string; water: string; time: string; q: string; w: string; dl: string; wkt: string };
const observations = (text: string): Obs[] =>
  cube(text).rows.map((r) => ({
    id: r[0] ?? '',
    name: r[1] ?? '',
    water: decodeURIComponent((r[2] ?? '').slice((r[2] ?? '').lastIndexOf('/') + 1)),
    time: r[3] ?? '',
    q: r[4] ?? '',
    w: r[5] ?? '',
    dl: r[7] ?? '',
    wkt: r[8] ?? '',
  }));
const obs = [...observations(inputs.river), ...observations(inputs.lake)];
const lakeIds = new Set(observations(inputs.lake).map((o) => o.id));
/** The station facts as the generator is meant to read them: the latest observation, the first of equal times. */
const latest = new Map<string, Obs>();
for (const o of obs) {
  const known = latest.get(o.id);
  if (known === undefined || Date.parse(o.time) > Date.parse(known.time)) latest.set(o.id, o);
}
const hasW = (id: string) => obs.some((o) => o.id === id && o.w !== '');
const hasQ = (id: string) => obs.some((o) => o.id === id && o.q !== '');
const withSeries = [...latest.keys()].filter((id) => hasW(id) || hasQ(id));

type Feature = { properties: Record<string, string | null> };
const features = (inputs.ch2 as { features: Feature[] }).features.map((f) => f.properties);

// Catalogue §3.1 (Swiss table), written out independently of the generator.
const TIER1 = [
  '2473',
  '2032',
  '2043',
  '2288',
  '2044',
  '2143',
  '2135',
  '2029',
  '2063',
  '2016',
  '2018',
  '2243',
  '2205',
  '2091',
  '2106',
  '2289',
  '2615',
];
/** Owner decision Q2: the water bodies outside the Rhine basin (their stations are audience off). */
const OFF_WATERS = [
  'Allaine',
  'Allondon',
  'Arve',
  'Aubonne',
  'Berninabach',
  'Bisse kalte Wasser',
  'Breggia',
  'Brenno',
  'Calancasca',
  'Canale industriale',
  'Cassarate',
  'Chamuerabach',
  'Derivazione Spöl',
  'Doubs',
  'Drance',
  'Drance de Bagnes',
  'Goneri',
  'Grande Eau',
  'Inn',
  'Innabl. EKW',
  'Krummbach',
  'Lac Léman',
  'Lac des Brenets',
  'Lago Maggiore',
  'Lago di Lugano',
  'Lonza',
  'Maggia',
  'Magliasina',
  'Massa',
  'Melera',
  'Mera',
  'Moesa',
  'Ova da Cluozza',
  'Ova dal Fuorn',
  'Poschiavino',
  'Promenthouse',
  'Rhône',
  'Riale di Calneggia',
  'Riale di Pincascia',
  'Riale di Roggiasca',
  'Rom',
  'Rosegbach',
  'Saltina',
  'Silsersee',
  'Silvaplanersee',
  'Sionne',
  'St. Moritzersee',
  'Ticino',
  'Tresa',
  'Vedeggio',
  'Venoge',
  'Verzasca',
  'Veveyse',
  'Vispa',
];
const RELATIVE = ['2251', '2252', '2282', '2283', '2329', '2384', '2632', '2636', '2650'];
const NO_SERIES = ['2113', '2130', '2392', '2462', '2613', '2623'];
const HOURLY = ['2007', '2137', '2251', '2252', '2319', '2327', '2384', '2436', '2474', '2646'];
const DISCHARGE_LS = ['2206', '2282', '2283', '2384', '2414', '2437'];

describe('registry/stations/ch-1.yaml', () => {
  it('is exactly what the generator writes from its inputs', () => {
    expect(committed.ch1).toBe(run().ch1);
  });

  it('is deterministic: the same input gives the same bytes and no timestamp', () => {
    expect(run()).toEqual(run());
    expect(committed.ch1.slice(committed.ch1.indexOf('\nstations:'))).not.toMatch(/\d{2}:\d{2}/);
  });

  it('is unchanged by a YAML 1.1 reader (numeric ids and "off" are quoted)', () => {
    expect(parse(committed.ch1, { version: '1.1' })).toEqual(parse(committed.ch1));
  });

  it('validates against the real sources with no problem', () => {
    expect(validateStations(parse(committed.ch1), sources).problems).toEqual([]);
  });

  it('names its inputs and their sha256 in the header: both cubes, the CH-2 GeoJSON, ch-4.csv and the steps table', () => {
    expect(inputs.files.map((f) => f.path)).toEqual([
      'apps/server/src/adapters/ch-1/fixtures/ch-1-lindas.raw',
      'apps/server/src/adapters/ch-1/fixtures/ch-1-lindas-lake.raw',
      'apps/server/src/adapters/ch-2/fixtures/ch-2-pq.raw',
      'registry/seed/ch-4.csv',
      'registry/seed/ch-1-steps.csv',
    ]);
    for (const f of inputs.files) expect(committed.ch1).toContain(`${f.path}  sha256 ${f.sha256}`);
  });

  it('holds one station per cube id with a W or Q value: 412 rows at 227 stations (224 H, 188 Q)', () => {
    // Both cubes together: 199 river ids (6 of them twice) and 34 lake ids; six have neither W nor Q.
    expect(latest.size).toBe(233);
    expect(codes(ch1)).toEqual([...withSeries].sort());
    expect(stationIds(ch1).size).toBe(227);
    expect(ch1).toHaveLength(412);
    expect(ch1.filter((r) => r.quantity === 'H')).toHaveLength(224);
    expect(ch1.filter((r) => r.quantity === 'Q')).toHaveLength(188);
    const silent = [...latest.keys()].filter((id) => !withSeries.includes(id)).sort();
    expect(silent).toEqual(NO_SERIES);
    expect(committed.ch1.replace(/\n#\s+/g, ' ')).toContain(
      `stations without a W or Q value in the recording (not registered): ${silent.join(', ')}.`,
    );
    for (const r of ch1) {
      const h = r.quantity === 'H';
      expect(r).toMatchObject({
        id: `ch.bafu.${r.provider_code}`,
        source: 'CH-1',
        provider_key: `${r.provider_code}/${h ? 'W' : 'Q'}`,
        country: 'CH',
        role: 'primary',
        river: null,
        km: null,
        native_unit: h ? 'm' : 'm³/s',
        to_canonical: h ? 100 : 1,
        licence_gate: 'open',
        gauge_zero: [],
      });
      expect(r.flags.tidal).toBeNull();
      expect(r.flags.impounded).toBeNull();
    }
  });

  it('is ordered by id as a string, then H before Q', () => {
    const keys = ch1.map((r) => `${r.provider_code}/${r.quantity === 'H' ? 0 : 1}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('resolves the six stations that a cube holds twice: one station, the row with the latest time', () => {
    const counts = new Map<string, number>();
    for (const o of observations(inputs.river)) counts.set(o.id, (counts.get(o.id) ?? 0) + 1);
    const twice = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
    expect(twice.sort()).toEqual(['2252', '2283', '2288', '2303', '2417', '520']);
    for (const id of twice) {
      expect(ch1.filter((r) => r.provider_code === id && r.quantity === 'H')).toHaveLength(hasW(id) ? 1 : 0);
      expect(ch1.filter((r) => r.provider_code === id && r.quantity === 'Q')).toHaveLength(hasQ(id) ? 1 : 0);
    }
    expect(find(ch1, '2288').name).toBe('Neuhausen, Flurlingerbrücke');
  });

  it('takes name, water_name (percent-decoded) and coordinates (the WKT) from the latest observation', () => {
    for (const r of ch1) {
      const o = latest.get(r.provider_code);
      const point = /^POINT\((\S+) (\S+)\)$/.exec(o?.wkt ?? '');
      expect([r.id, r.name, r.water_name, r.lon, r.lat]).toEqual([
        r.id,
        o?.name,
        o?.water,
        Number(point?.[1]),
        Number(point?.[2]),
      ]);
    }
    // Names exactly as published, trailing blanks included; escapes decoded, raw UTF-8 kept.
    expect(find(ch1, '2044').name).toBe('Andelfingen    ');
    expect(find(ch1, '2203').water_name).toBe('Grande Eau');
    expect(find(ch1, '2032').water_name).toBe('Bodensee, Obersee');
    expect(find(ch1, '2026').water_name).toBe('Lac Léman');
    expect(find(ch1, '2025').water_name).toBe('Vierwaldstättersee');
    expect(find(ch1, '2232')).toMatchObject({ lon: 7.552070650295653, lat: 46.4859592583082 });
  });

  it('declares a relative gauge (a W below 150 m, e.g. 2283 at -0.136) a stage with datum LOCAL, every other W an LN02 level', () => {
    const relative = ch1.filter((r) => r.quantity === 'H' && r.value_kind === 'stage');
    expect(codes(relative)).toEqual(RELATIVE);
    for (const id of RELATIVE) expect(Number(latest.get(id)?.w)).toBeLessThan(150);
    expect(find(ch1, '2283')).toMatchObject({
      value_kind: 'stage',
      datum: 'LOCAL',
      native_unit: 'm',
      to_canonical: 100,
    });
    expect(find(ch1, '2289')).toMatchObject({ value_kind: 'level', datum: 'LN02' });
    for (const r of ch1) {
      const h = r.quantity === 'H';
      const stage = RELATIVE.includes(r.provider_code);
      expect([r.id, r.value_kind, r.datum]).toEqual([
        r.id,
        h ? (stage ? 'stage' : 'level') : null,
        h ? (stage ? 'LOCAL' : 'LN02') : null,
      ]);
    }
  });

  describe('the scope (owner decision Q2)', () => {
    it('is audience off exactly for the stations on a non-Rhine water body: the Rhône and Léman, Doubs, Po basin, Inn, Adige', () => {
      const off = ch1.filter((r) => r.audience === 'off');
      expect([...new Set(off.map((r) => r.water_name))].sort()).toEqual([...OFF_WATERS].sort());
      expect(stationIds(off).size).toBe(75);
      expect(off).toHaveLength(136);
      for (const r of ch1) {
        expect([r.id, r.audience]).toEqual([r.id, OFF_WATERS.includes(r.water_name ?? '') ? 'off' : 'public']);
      }
      expect(stationIds(ch1.filter((r) => r.audience === 'public')).size).toBe(152);
      // Spot checks by geography.
      for (const water of ['Rhône', 'Lac Léman', 'Doubs', 'Ticino', 'Lago Maggiore', 'Inn', 'Silsersee', 'Rom']) {
        expect(
          ch1.filter((r) => r.water_name === water).every((r) => r.audience === 'off'),
          water,
        ).toBe(true);
      }
      for (const water of ['Rhein', 'Aare', 'Orbe', 'Lac de Joux', 'Bodensee, Obersee', 'Zürichsee', 'Birs']) {
        const of = ch1.filter((r) => r.water_name === water);
        expect(of.length, water).toBeGreaterThan(0);
        expect(
          of.every((r) => r.audience === 'public'),
          water,
        ).toBe(true);
      }
    });

    it('keeps the licence open for every row: off is a scope decision for the NL-bound site, not a licence gate', () => {
      expect(new Set(ch1.map((r) => r.licence_gate))).toEqual(new Set(['open']));
      expect(committed.ch1.replace(/\n#\s+/g, ' ')).toContain(
        'scope decision for the NL-bound site, not a licence gate',
      );
    });
  });

  describe('the lake cube', () => {
    it('gives its 34 stations flags.lake true and no other row a lake key', () => {
      expect(lakeIds.size).toBe(34);
      expect(codes(ch1.filter((r) => r.flags.lake === true))).toEqual([...lakeIds].sort());
      for (const r of ch1) expect([r.id, 'lake' in r.flags]).toEqual([r.id, lakeIds.has(r.provider_code)]);
    });

    it('registers the lake level as W only (no discharge), an LN02 level', () => {
      for (const r of ch1.filter((x) => x.flags.lake === true)) {
        expect([r.id, r.quantity, r.value_kind, r.datum]).toEqual([r.id, 'H', 'level', 'LN02']);
      }
    });
  });

  describe('tier 1', () => {
    it('marks exactly the 17 stations of the catalogue §3.1 Swiss table (31 rows) as tier 1 and first_release', () => {
      const tier1 = ch1.filter((r) => r.tier === 1);
      expect(codes(tier1)).toEqual([...TIER1].sort());
      expect(tier1).toHaveLength(31);
      expect(tier1.filter((r) => r.quantity === 'H')).toHaveLength(17);
      expect(tier1.filter((r) => r.quantity === 'Q')).toHaveLength(14);
      expect(tier1.every((r) => r.first_release && r.role === 'primary' && r.audience === 'public')).toBe(true);
      expect(ch1.filter((r) => r.tier === 2).every((r) => !r.first_release)).toBe(true);
    });

    it('holds the Bodensee (Obersee 2032, Untersee 2043) as lake W rows, and Basel LHG 2615 as a W row without thresholds', () => {
      for (const id of ['2032', '2043']) {
        expect(ch1.filter((r) => r.provider_code === id)).toHaveLength(1);
        expect(find(ch1, id)).toMatchObject({ tier: 1, flags: { lake: true }, expected_threshold_source: 'CH-1' });
      }
      expect(ch1.filter((r) => r.provider_code === '2615').map((r) => r.quantity)).toEqual(['H']);
      expect(find(ch1, '2615')).toMatchObject({ tier: 1, expected_threshold_source: null });
    });
  });

  describe('thresholds, forecasts and steps', () => {
    it('names CH-1 as the threshold source where the latest observation states danger levels, not where it says cube:Undefined', () => {
      for (const r of ch1) {
        const dl = latest.get(r.provider_code)?.dl ?? '';
        expect([r.id, r.expected_threshold_source]).toEqual([r.id, /^[1-5]$/.test(dl) ? 'CH-1' : null]);
      }
      expect(new Set(ch1.map((r) => r.expected_threshold_source))).toEqual(new Set(['CH-1', null]));
      expect(ch1.filter((r) => r.expected_threshold_source === 'CH-1')).toHaveLength(345);
    });

    it('names CH-4 as the forecast source of the 54 stations of ch-4.csv (95 rows), no other', () => {
      const forecast = new Set(inputs.ch4.map((r) => r.id));
      expect(forecast.size).toBe(54);
      for (const r of ch1) {
        expect([r.id, r.expected_forecast_source]).toEqual([r.id, forecast.has(r.provider_code) ? 'CH-4' : null]);
      }
      expect(ch1.filter((r) => r.expected_forecast_source === 'CH-4')).toHaveLength(95);
      expect(codes(ch1.filter((r) => r.expected_forecast_source === 'CH-4'))).toEqual([...forecast].sort());
    });

    it('takes the step from the steps table, PT10M without an entry; 10 stations are hourly (stale after PT3H)', () => {
      const steps = new Map(inputs.steps?.map((r) => [r.id, r.native_step]));
      expect(steps.size).toBe(233);
      for (const r of ch1) {
        const step = steps.get(r.provider_code) ?? 'PT10M';
        expect([r.id, r.native_step, r.expected_step, r.staleness_limit]).toEqual([
          r.id,
          step,
          step,
          step === 'PT10M' ? 'PT1H' : 'PT3H',
        ]);
      }
      expect(codes(ch1.filter((r) => r.native_step === 'PT1H'))).toEqual(HOURLY);
      expect(ch1.filter((r) => r.native_step === 'PT1H')).toHaveLength(18);
      // A station that reports every 10 minutes comes out PT10M.
      for (const id of ['2289', '2473', '2615', '2032', '2043']) expect(steps.get(id), id).toBe('PT10M');
    });
  });
});

describe('registry/stations/ch-2.yaml', () => {
  it('is exactly what the generator writes, deterministic, YAML 1.1 safe and valid against the real sources', () => {
    expect(committed.ch2).toBe(run().ch2);
    expect(committed.ch2.slice(committed.ch2.indexOf('\nstations:'))).not.toMatch(/\d{2}:\d{2}/);
    expect(parse(committed.ch2, { version: '1.1' })).toEqual(parse(committed.ch2));
    expect(validateStations(parse(committed.ch2), sources).problems).toEqual([]);
  });

  it('holds a twin per sensor of the 207 features: 380 rows (205 H, 175 Q), role twin, tier 2, never first_release', () => {
    expect(features).toHaveLength(207);
    expect(stationIds(ch2).size).toBe(207);
    expect(ch2).toHaveLength(380);
    expect(ch2.filter((r) => r.quantity === 'H')).toHaveLength(205);
    expect(ch2.filter((r) => r.quantity === 'Q')).toHaveLength(175);
    for (const r of ch2) {
      expect(r).toMatchObject({
        id: `ch.bafu-pq.${r.provider_code}`,
        source: 'CH-2',
        provider_key: `${r.provider_code}/${r.quantity === 'H' ? 'W' : 'Q'}`,
        role: 'twin',
        tier: 2,
        first_release: false,
        country: 'CH',
        river: null,
        km: null,
        expected_threshold_source: null,
        expected_forecast_source: null,
        licence_gate: 'open',
        gauge_zero: [],
      });
    }
    const keys = ch2.map((r) => `${r.provider_code}/${r.quantity === 'H' ? 0 : 1}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('maps every sensor value of ch-2-pq.raw to a registered CH-2 series, and nothing else', () => {
    const want: string[] = [];
    for (const f of features) {
      if (f.sensor_waterlevel_last_value !== null && f.sensor_waterlevel_last_value !== undefined) {
        want.push(`${f.key}/W`);
        const unit = f.sensor_waterlevel_last_value.replace(/^-?[\d.]+ /, '');
        expect([f.key, find(ch2, f.key ?? '').value_kind, find(ch2, f.key ?? '').datum]).toEqual([
          f.key,
          unit === 'm ü.M.' ? 'level' : 'stage',
          unit === 'm ü.M.' ? 'LN02' : 'LOCAL',
        ]);
      }
      if (f.sensor_discharge_last_value !== null && f.sensor_discharge_last_value !== undefined) {
        want.push(`${f.key}/Q`);
        const ls = f.sensor_discharge_last_value.endsWith(' l/s');
        expect([f.key, find(ch2, f.key ?? '', 'Q').native_unit, find(ch2, f.key ?? '', 'Q').to_canonical]).toEqual([
          f.key,
          ls ? 'l/s' : 'm³/s',
          ls ? 0.001 : 1,
        ]);
      }
    }
    expect(want.length).toBeGreaterThan(300);
    expect(ch2.map((r) => r.provider_key).sort()).toEqual(want.sort());
  });

  it('declares the six l/s stations x0.001 and the three relative gauges stage LOCAL, the rest m³/s and LN02 levels', () => {
    expect(codes(ch2.filter((r) => r.native_unit === 'l/s'))).toEqual(DISCHARGE_LS);
    expect(ch2.filter((r) => r.native_unit === 'l/s').every((r) => r.to_canonical === 0.001)).toBe(true);
    expect(codes(ch2.filter((r) => r.value_kind === 'stage'))).toEqual(['2282', '2283', '2384']);
    expect(ch2.filter((r) => r.value_kind === 'level')).toHaveLength(202);
    for (const r of ch2.filter((x) => x.quantity === 'H')) {
      expect([r.id, r.native_unit, r.to_canonical]).toEqual([r.id, 'm', 100]);
    }
  });

  it('agrees with the CH-1 W series of the same id on level and stage, and takes coordinates, audience, flags and step from CH-1', () => {
    for (const r of ch2) {
      const station = ch1.filter((x) => x.provider_code === r.provider_code);
      if (station.length === 0) continue;
      const w = station.find((x) => x.quantity === 'H');
      if (r.quantity === 'H' && w !== undefined)
        expect([r.id, r.value_kind, r.datum]).toEqual([r.id, w.value_kind, w.datum]);
      expect([r.id, r.lon, r.lat, r.audience, r.flags, r.native_step, r.staleness_limit]).toEqual([
        r.id,
        station[0]?.lon,
        station[0]?.lat,
        station[0]?.audience,
        station[0]?.flags,
        station[0]?.native_step,
        station[0]?.staleness_limit,
      ]);
    }
    // 2384 and 2283 are relative on both sides; 2289 is a level on both.
    expect(find(ch2, '2384')).toMatchObject({ value_kind: 'stage', datum: 'LOCAL' });
    expect(find(ch2, '2289')).toMatchObject({ value_kind: 'level', datum: 'LN02' });
  });

  it('takes name from the label and water_name from hydro_body_name', () => {
    for (const f of features) {
      for (const r of ch2.filter((x) => x.provider_code === f.key)) {
        expect([r.id, r.name, r.water_name]).toEqual([r.id, f.label, f.hydro_body_name]);
      }
    }
    expect(find(ch2, '2289').name).toBe('Rhein - Basel, Rheinhalle');
  });

  it('registers a Q twin where the feature has a discharge sensor whatever its metric says (2447 Sugiez, 2446 Gampelen: metric masl)', () => {
    for (const id of ['2447', '2446']) {
      expect(features.find((f) => f.key === id)?.metric).toBe('masl');
      expect(ch2.filter((r) => r.provider_code === id).map((r) => r.quantity)).toEqual(['H', 'Q']);
      expect(find(ch2, id, 'Q')).toMatchObject({ native_unit: 'm³/s', audience: 'public' });
    }
  });

  it('registers 2648 Innableitung EKW (a Q sensor, no CH-1 station) on its own water body: audience off, no coordinates', () => {
    expect(ch1.filter((r) => r.provider_code === '2648')).toEqual([]);
    expect(ch2.filter((r) => r.provider_code === '2648').map((r) => r.quantity)).toEqual(['Q']);
    expect(find(ch2, '2648', 'Q')).toMatchObject({
      id: 'ch.bafu-pq.2648',
      name: 'Innableitung EKW - Martina',
      water_name: 'Innableitung EKW',
      audience: 'off',
      lon: null,
      lat: null,
      native_unit: 'm³/s',
    });
    expect(committed.ch2.replace(/\n#\s+/g, ' ')).toContain(
      'CH-2 keys that are no CH-1 station (audience from their own water body, no coordinates): 2648.',
    );
  });

  it('is audience off exactly for the twins of off CH-1 stations (and 2648), flags.lake on the 31 lake features', () => {
    const offIds = new Set(ch1.filter((r) => r.audience === 'off').map((r) => r.provider_code));
    offIds.add('2648');
    for (const r of ch2) expect([r.id, r.audience]).toEqual([r.id, offIds.has(r.provider_code) ? 'off' : 'public']);
    expect(stationIds(ch2.filter((r) => r.audience === 'off')).size).toBe(71);
    expect(codes(ch2.filter((r) => r.flags.lake === true))).toEqual(
      features
        .filter((f) => f.kind === 'lake')
        .map((f) => f.key ?? '')
        .sort(),
    );
    expect(stationIds(ch2.filter((r) => r.flags.lake === true)).size).toBe(31);
  });
});

describe('scripts/gen-ch1-stations.ts --steps', () => {
  const HEADER = 'id,name,water,time,q,w,t,dl,wkt';
  const at = (minutes: number) =>
    new Date(Date.UTC(2026, 8, 30, 10, 0) + minutes * 60_000).toISOString().replace('.000Z', '+00:00');
  const row = (id: string, minutes: number) =>
    `${id},"Name, ${id}",https://environment.ld.admin.ch/foen/hydro/waterbody/Aare,${at(minutes)},1.5,400.1,,1,POINT(8 47)`;
  /** One payload per observation time, as the archive holds them: CRLF, each with its own header line, concatenated. */
  const day = (stations: Record<string, number[]>) => {
    const times = [...new Set(Object.values(stations).flat())].sort((a, b) => a - b);
    return times
      .map((t) => {
        const rows = Object.entries(stations).flatMap(([id, list]) =>
          list.filter((x) => x === t).map(() => row(id, t)),
        );
        return `${HEADER}\r\n${rows.join('\r\n')}\r\n`;
      })
      .join('');
  };
  const SHA = 'ab'.repeat(32);
  const csvRows = (text: string) =>
    text
      .split('\n')
      .filter((l) => !l.startsWith('#') && l !== '' && !l.startsWith('id,'))
      .map((l) => l.split(','));

  it('takes the modal gap of the distinct observation times of each station: a tie takes the smaller gap, a repeat counts once', () => {
    const text = deriveSteps(
      day({
        '100': [0, 0, 10, 20], // a repeated time is one point: 10, 10
        '200': [0, 60, 120], // hourly
        '300': [0, 10, 20, 40], // 10, 10, 20 -> 10
        '400': [0, 20, 40, 50], // 20, 20, 10 -> 20
        '500': [0, 10, 30], // a tie between 10 and 20 -> 10
        '600': [0, 30, 60, 70], // 30, 30, 10 -> 30
      }),
      'day.csv',
      SHA,
    );
    expect(csvRows(text)).toEqual([
      ['100', 'PT10M', '3'],
      ['200', 'PT1H', '3'],
      ['300', 'PT10M', '4'],
      ['400', 'PT20M', '4'],
      ['500', 'PT10M', '3'],
      ['600', 'PT30M', '4'],
    ]);
  });

  it('names the day and its sha256, sorts the ids as strings and lists a station with one time (PT10M by rule)', () => {
    const text = deriveSteps(day({ '9': [0, 10], '10': [0], '700': [5, 5] }), 'ch-1-day.csv.gz', SHA);
    expect(text.split('\n').slice(0, 3)).toEqual([
      `# derived by scripts/gen-ch1-stations.ts --steps from ch-1-day.csv.gz sha256 ${SHA}`,
      '# one time only (step PT10M by rule): 10, 700',
      'id,native_step,points',
    ]);
    expect(csvRows(text)).toEqual([
      ['10', 'PT10M', '1'],
      ['700', 'PT10M', '1'],
      ['9', 'PT10M', '2'],
    ]);
  });

  it('fails on a step outside the allowed set, naming every such station', () => {
    expect(() => deriveSteps(day({ '800': [0, 15, 30], '900': [0, 45] }), 'x', SHA)).toThrow(
      /stations with a step outside PT10M, PT20M, PT30M, PT1H: 800 \(15 min\), 900 \(45 min\)/,
    );
  });

  it('fails on a header that is not the query variables (first or repeated), a bad id or time, or no observation', () => {
    expect(() => deriveSteps(`id,name\r\n1,x\r\n`, 'x', SHA)).toThrow(/steps input: the CSV header is not/);
    const good = day({ '100': [0, 10] });
    expect(() => deriveSteps(`${good}id,name,water,time,q,w,t,dl,xxx\r\n`, 'x', SHA)).toThrow(
      /steps input row \d+: the CSV header is not/,
    );
    expect(() => deriveSteps(`${good}abc,n,w,${at(0)},,,,,\r\n`, 'x', SHA)).toThrow(
      /steps input row \d+: not a station id and an observation time/,
    );
    expect(() => deriveSteps(`${good}100,n,w,2026-09-30 10:00,,,,,\r\n`, 'x', SHA)).toThrow(
      /steps input row \d+: not a station id and an observation time/,
    );
    expect(() => deriveSteps(`${HEADER}\r\n`, 'x', SHA)).toThrow(/no observation/);
    // A shifted column never passes (the CSV scan: every row as wide as the header).
    expect(() => deriveSteps(`${good}100,n,w,${at(0)},1,2,3,4,POINT(8 47),extra\r\n`, 'x', SHA)).toThrow();
  });

  it('reads a plain and a gzip file (told by the magic bytes), with the sha256 of the bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ch1-steps-'));
    try {
      const body = day({ '100': [0, 10, 20] });
      writeFileSync(join(dir, 'a.csv'), body);
      writeFileSync(join(dir, 'b.csv.gz'), gzipSync(body));
      writeFileSync(join(dir, 'c.csv'), gzipSync(body)); // the extension does not decide
      const plain = deriveStepsFile(join(dir, 'a.csv'));
      expect(csvRows(plain)).toEqual([['100', 'PT10M', '3']]);
      expect(csvRows(deriveStepsFile(join(dir, 'b.csv.gz')))).toEqual(csvRows(plain));
      expect(csvRows(deriveStepsFile(join(dir, 'c.csv')))).toEqual(csvRows(plain));
      const sha = createHash('sha256').update(gzipSync(body)).digest('hex');
      expect(deriveStepsFile(join(dir, 'b.csv.gz')).split('\n')[0]).toBe(
        `# derived by scripts/gen-ch1-stations.ts --steps from b.csv.gz sha256 ${sha}`,
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  describe('registry/seed/ch-1-steps.csv', () => {
    const text = readFileSync(`${repoRoot}registry/seed/ch-1-steps.csv`, 'utf8');

    it('names the day of payloads it was derived from with its sha256', () => {
      expect(text.split('\n')[0]).toMatch(
        /^# derived by scripts\/gen-ch1-stations\.ts --steps from \S+ sha256 [0-9a-f]{64}$/,
      );
      expect(text).toContain('# one time only (step PT10M by rule): 2269, 2356');
    });

    it('holds one entry per cube station (233), sorted as strings, with the allowed steps (10 hourly stations in the registry)', () => {
      const rows = csvRows(text);
      expect(rows).toHaveLength(233);
      expect(rows.map((r) => r[0])).toEqual([...latest.keys()].sort());
      expect(new Set(rows.map((r) => r[1]))).toEqual(new Set(['PT10M', 'PT1H']));
      expect(rows.every((r) => Number(r[2]) >= 1)).toBe(true);
      // 11 stations are hourly in the day, 10 of them have a series (the 11th, 2623 on the Rhône, has neither W nor Q).
      expect(rows.filter((r) => r[1] === 'PT1H').map((r) => r[0])).toEqual([...HOURLY, '2623'].sort());
    });
  });
});

describe('scripts/gen-ch1-stations.ts fails loudly', () => {
  const quote = (f: string) => (/[",\n]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f);
  const csv = (header: string[], rows: string[][]) =>
    `${[header, ...rows].map((r) => r.map(quote).join(',')).join('\n')}\n`;
  /** The generator with one cube replaced by `change(rows)`. */
  const withCube = (which: 'river' | 'lake', change: (rows: string[][]) => string[][]) => () => {
    const { header, rows } = cube(inputs[which]);
    return run({ [which]: csv(header, change(rows)) });
  };
  /** The same with the rows edited in place. */
  const editCube = (which: 'river' | 'lake', edit: (rows: string[][]) => void) =>
    withCube(which, (rows) => {
      edit(rows);
      return rows;
    });
  const rowOf = (rows: string[][], id: string) => {
    const found = rows.find((r) => r[0] === id);
    if (found === undefined) throw new Error(`no fixture row ${id}`);
    return found;
  };
  /** Sets one column of the cube row of a station (0 id, 1 name, 2 water, 3 time, 4 q, 5 w, 7 dl, 8 wkt). */
  const set = (id: string, column: number, value: string) => (rows: string[][]) => {
    rowOf(rows, id)[column] = value;
  };
  const WATER = 'https://environment.ld.admin.ch/foen/hydro/waterbody/';
  const withCh2 = (change: (features: Feature[]) => void) => () => {
    const ch2Copy = structuredClone(inputs.ch2) as { features: Feature[] };
    change(ch2Copy.features);
    return run({ ch2: ch2Copy });
  };
  const feature = (list: Feature[], key: string) => {
    const found = list.find((f) => f.properties.key === key);
    if (found === undefined) throw new Error(`no fixture feature ${key}`);
    return found.properties;
  };
  const setFeature = (key: string, field: string, value: string) => (list: Feature[]) => {
    feature(list, key)[field] = value;
  };

  it('on a water body in neither scope table, and on a scope table entry that no cube has any more', () => {
    expect(editCube('river', set('2044', 2, `${WATER}Neuer%20Bach`))).toThrow(
      /water bodies in neither scope table \(RHINE, NON_RHINE\): Neuer Bach/,
    );
    // Werkkanal (2156, Gerlafingen) has no CH-2 feature either.
    expect(withCube('river', (rows) => rows.filter((r) => r[0] !== '2156'))).toThrow(
      /scope table entry Werkkanal is in no cube any more/,
    );
  });

  it('on a bad percent escape or an empty or control-character water body', () => {
    expect(editCube('river', set('2044', 2, `${WATER}Bad%ZZ`))).toThrow(
      /river cube station 2044: a bad percent escape in the water IRI/,
    );
    expect(editCube('river', set('2044', 2, WATER))).toThrow(
      /river cube station 2044: the water IRI has no plain last path segment/,
    );
    expect(editCube('river', set('2044', 2, ''))).toThrow(/river cube station 2044: no water body/);
    expect(editCube('river', set('2044', 2, `${WATER}Thur%0Aevil`))).toThrow(
      /river cube station 2044\.water: a control or format character/,
    );
  });

  it('on a WKT that is not POINT(lon lat), or off the globe', () => {
    for (const wkt of ['POINT(8.68 47.59 5)', 'LINESTRING(8 47, 9 48)', 'POINT(8.68, 47.59)', 'POINT EMPTY']) {
      expect(editCube('river', set('2044', 8, wkt))).toThrow(
        /river cube station 2044: the WKT is not POINT\(lon lat\)/,
      );
    }
    expect(editCube('river', set('2044', 8, 'POINT(500 47)'))).toThrow(
      /river cube station 2044: the WKT is outside the globe/,
    );
  });

  it('on a name over 200 characters or with a bidi character', () => {
    expect(editCube('river', set('2044', 1, 'x'.repeat(201)))).toThrow(
      /river cube station 2044\.name: longer than 200 characters/,
    );
    expect(editCube('river', set('2044', 1, 'Thur\u202e'))).toThrow(
      /river cube station 2044\.name: a control or format character/,
    );
  });

  it('on a header that is not the query variables, a bad id, time or number, a shifted row', () => {
    const { rows } = cube(inputs.river);
    expect(() =>
      run({
        river: csv(
          ['id', 'name'],
          rows.map((r) => r.slice(0, 2)),
        ),
      }),
    ).toThrow(/river cube: the CSV header is not id,name,water,time,q,w,t,dl,wkt/);
    expect(editCube('river', set('2044', 0, 'abc'))).toThrow(/river cube row \d+: bad station id/);
    expect(editCube('river', set('2044', 3, '2026-09-29 14:20'))).toThrow(/river cube row \d+: bad observation time/);
    expect(editCube('river', set('2044', 5, '4e2x'))).toThrow(/river cube row \d+: bad number/);
    expect(() => run({ river: `${inputs.river}2044,extra\r\n` })).toThrow(/csv_width/);
  });

  it('on a tier-1 station that has no series, that is missing from its cube, or that is on a non-Rhine water body', () => {
    expect(
      editCube('river', (rows) => {
        for (const r of rows.filter((x) => x[0] === '2473')) {
          r[4] = '';
          r[5] = '';
        }
      }),
    ).toThrow(/tier-1 station 2473 has no series/);
    expect(withCube('river', (rows) => rows.filter((r) => r[0] !== '2289'))).toThrow(
      /tier-1 station 2289 is not in the river cube/,
    );
    expect(withCube('lake', (rows) => rows.filter((r) => r[0] !== '2032'))).toThrow(
      /tier-1 station 2032 is not in the lake cube/,
    );
    expect(editCube('river', set('2289', 2, `${WATER}Rh%C3%B4ne`))).toThrow(
      /tier-1 station 2289 is on the non-Rhine water body Rhône/,
    );
  });

  it('on a station in both cubes, and on W values on both sides of 150 m', () => {
    expect(withCube('lake', (rows) => [...rows, [...rowOf(cube(inputs.river).rows, '2044')]])).toThrow(
      /station 2044 is in the river cube and the lake cube/,
    );
    expect(
      withCube('river', (rows) => {
        const copy = [...rowOf(rows, '2283')];
        copy[5] = '500.1';
        return [...rows, copy];
      }),
    ).toThrow(/river cube station 2283: W values on both sides of 150 m/);
  });

  it('on a CH-2 feature with a unit, kind or sensor it does not know, or a duplicate key', () => {
    expect(withCh2(setFeature('2289', 'sensor_waterlevel_last_value', '244.78 ft'))).toThrow(
      /ch-2 feature 2289\.sensor_waterlevel_last_value: unknown unit "ft"/,
    );
    expect(withCh2(setFeature('2289', 'sensor_discharge_last_value', '340 m3/d'))).toThrow(
      /ch-2 feature 2289\.sensor_discharge_last_value: unknown unit "m3\/d"/,
    );
    expect(withCh2(setFeature('2289', 'sensor_discharge_last_value', 'NaN m³/s'))).toThrow(
      /sensor_discharge_last_value is not "<number> <unit>"/,
    );
    expect(withCh2(setFeature('2289', 'kind', 'sea'))).toThrow(/ch-2 feature 2289: unknown kind "sea"/);
    expect(
      withCh2((fs) => {
        Object.assign(feature(fs, '2289'), { sensor_discharge_last_value: null, sensor_waterlevel_last_value: null });
      }),
    ).toThrow(/ch-2 feature 2289: no sensor value/);
    expect(withCh2((fs) => void fs.push(structuredClone(fs[0] as Feature)))).toThrow(/ch-2 feature \d+: duplicate key/);
  });

  it('on a CH-2 level that disagrees with the CH-1 W series: a level where CH-1 has a stage, a stage where it has a level', () => {
    expect(withCh2(setFeature('2289', 'sensor_waterlevel_last_value', '244.78 m'))).toThrow(
      /ch-2 feature 2289: the level unit says stage, CH-1 says level/,
    );
    expect(withCh2(setFeature('2283', 'sensor_waterlevel_last_value', '700.1 m ü.M.'))).toThrow(
      /ch-2 feature 2283: the level unit says level, CH-1 says stage/,
    );
  });

  it('on a CH-2 feature that is no CH-1 station and has no water body, or one in neither scope table', () => {
    expect(withCh2(setFeature('2648', 'hydro_body_name', ''))).toThrow(
      /ch-2 feature 2648: no CH-1 station and no water body to classify/,
    );
    expect(withCh2(setFeature('2648', 'hydro_body_name', 'Neuer Bach'))).toThrow(
      /water bodies in neither scope table \(RHINE, NON_RHINE\): Neuer Bach/,
    );
  });

  it('on a steps entry for an unknown station, a step outside the allowed set or a duplicate; and on a ch-4 row without an id', () => {
    const steps = inputs.steps ?? [];
    const entry = (change: Record<string, string>) => ({ id: '2289', native_step: 'PT10M', points: '5', ...change });
    const without = steps.filter((r) => r.id !== '2289');
    expect(() => run({ steps: [...without, entry({ id: '9999' })] })).toThrow(/station 9999 is in no cube/);
    expect(() => run({ steps: [...without, entry({ native_step: 'PT15M' })] })).toThrow(
      /station 2289 has the step "PT15M", outside the allowed set/,
    );
    expect(() => run({ steps: [...steps, entry({})] })).toThrow(/duplicate station 2289/);
    expect(() => run({ ch4: [{}] })).toThrow(/ch-4\.csv row 1\.id: expected a non-empty string/);
  });

  describe('keeps a station from its latest observation', () => {
    const copyOf = (id: string, change: (copy: string[]) => void) =>
      withCube('river', (rows) => {
        const copy = [...rowOf(rows, id)];
        change(copy);
        return [...rows, copy];
      });
    const nameOf = (make: () => { ch1: string }) => find(rowsOf(make().ch1), '2044').name;

    it('an older duplicate changes nothing; a newer one wins; of equal times the first wins', () => {
      expect(
        copyOf('2044', (c) => {
          c[1] = 'Older name';
          c[3] = '2026-09-20T10:00:00+01:00';
        })().ch1,
      ).toBe(committed.ch1);
      expect(
        nameOf(
          copyOf('2044', (c) => {
            c[1] = 'Newer name';
            c[3] = '2026-09-30T10:00:00+01:00';
          }),
        ),
      ).toBe('Newer name');
      expect(
        copyOf('2044', (c) => {
          c[1] = 'Second of equal time';
        })().ch1,
      ).toBe(committed.ch1);
    });
  });
});
