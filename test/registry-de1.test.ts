import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type PublicStation, SourcesFile, StationsFile, validateStations } from '../packages/contracts/src/index.ts';
import { generate, OUTPUT, readInputs } from '../scripts/gen-de1-stations.ts';
import { repoRoot, strip } from './catalogue.ts';

// registry/stations/de-1.yaml is generated (scripts/gen-de1-stations.ts) from the two recorded
// PEGELONLINE fixtures: the committed file is exactly the generator's output, and it holds what
// the catalogue (§3.1, §3.2) says about the key gauges.

const committed = readFileSync(OUTPUT, 'utf8');
const inputs = readInputs();
const run = (basin: unknown = inputs.basin, meta: unknown = inputs.meta) => generate(basin, meta, inputs.recordedAt);
const sources = SourcesFile.parse(parse(readFileSync(`${repoRoot}registry/sources.yaml`, 'utf8'))).sources;
const catalogue = strip(readFileSync(`${repoRoot}docs/sources/SOURCE-CATALOGUE.md`, 'utf8'));

// Every DE-1 row carries datum and gauge-zero metadata; one (NEUWIED STADT) is audience off.
const rows = StationsFile.parse(parse(committed)).stations.filter((s): s is PublicStation => s.audience !== 'owner');
const stationIds = (of: PublicStation[]) => new Set(of.map((r) => r.id));
const find = (number: string, quantity: 'H' | 'Q' = 'H') => {
  const row = rows.find((r) => r.provider_code === number && r.quantity === quantity);
  if (row === undefined) throw new Error(`no DE-1 row ${number} ${quantity}`);
  return row;
};

const TIER1_WITHOUT_CATALOGUE_UUID = ['26100130', '26100140', '26100200'];
const MIRRORS = [
  ['2790050', 'NL'],
  ['2790060', 'NL'],
  ['2310010', 'CH'],
  ['3329', 'DE'],
  ['2769510000100', 'DE'],
] as const;

describe('registry/stations/de-1.yaml', () => {
  it('is exactly what the generator writes from the recorded fixtures', () => {
    expect(committed).toBe(run());
  });

  it('is deterministic: the same input gives the same bytes and no timestamp', () => {
    expect(run()).toBe(run());
    // Only the header names the fixtures' recorded_at; the rows hold no time of day.
    expect(committed.slice(committed.indexOf('\nstations:'))).not.toMatch(/\d{2}:\d{2}/);
  });

  it('is unchanged by a YAML 1.1 reader (numbers, dates and "off"-like strings are quoted)', () => {
    expect(parse(committed, { version: '1.1' })).toEqual(parse(committed));
  });

  it('validates against the real sources with no problem', () => {
    expect(validateStations(parse(committed), sources).problems).toEqual([]);
  });

  it('holds one DE-1 row per basin station and quantity (199 stations), public and open but for one', () => {
    expect(stationIds(rows).size).toBe(199);
    expect(rows).toHaveLength(238);
    expect(rows.filter((r) => r.quantity === 'H')).toHaveLength(198);
    expect(rows.filter((r) => r.quantity === 'Q')).toHaveLength(40);
    const offRow = (r: PublicStation) => r.provider_code === '27100370';
    expect(rows.filter(offRow)).toHaveLength(1);
    for (const r of rows) {
      const want = offRow(r) ? ['off', 'withheld'] : ['public', 'open'];
      expect([r.id, r.source, r.audience, r.licence_gate]).toEqual([r.id, 'DE-1', ...want]);
      expect([r.id, r.expected_forecast_source]).toEqual([r.id, null]);
      expect(r.provider_key).toBe(`${r.provider_key.slice(0, 36)}/${r.quantity === 'H' ? 'W' : 'Q'}`);
    }
  });

  it('is ordered by station number as a string, then H before Q', () => {
    const keys = rows.map((r) => `${r.provider_code}/${r.quantity === 'H' ? 0 : 1}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('marks exactly the 41 catalogue key stations (69 rows) as tier 1 and first_release', () => {
    const tier1 = rows.filter((r) => r.tier === 1);
    expect(stationIds(tier1).size).toBe(41);
    expect(tier1).toHaveLength(69);
    expect(tier1.every((r) => r.first_release && r.role === 'primary')).toBe(true);
    expect(rows.filter((r) => r.tier === 2).every((r) => !r.first_release)).toBe(true);
    expect(tier1.filter((r) => r.quantity === 'H')).toHaveLength(40);
    expect(tier1.filter((r) => r.quantity === 'Q')).toHaveLength(29);
  });

  it('carries the UUID SOURCE-CATALOGUE.md §3 prints for each key station (three print none)', () => {
    for (const r of rows.filter((x) => x.tier === 1 && x.quantity === 'H')) {
      const uuid = r.provider_key.slice(0, 36);
      const printed = catalogue.includes(`${r.provider_code} ${uuid}`);
      expect([r.provider_code, printed]).toEqual([
        r.provider_code,
        !TIER1_WITHOUT_CATALOGUE_UUID.includes(r.provider_code),
      ]);
    }
    // Stations with no W row (Alken) are covered by their Q row.
    const alken = find('26900510', 'Q');
    expect(catalogue).toContain(`26900510 ${alken.provider_key.slice(0, 36)}`);
  });

  it('declares the five PEGELONLINE mirrors as role mirror, tier 2, not first_release', () => {
    for (const [number, country] of MIRRORS) {
      for (const r of rows.filter((x) => x.provider_code === number)) {
        expect([number, r.role, r.tier, r.first_release, r.country]).toEqual([number, 'mirror', 2, false, country]);
      }
    }
    expect(stationIds(rows.filter((r) => r.role === 'mirror')).size).toBe(MIRRORS.length);
    expect(rows.filter((r) => r.role !== 'mirror').every((r) => r.role === 'primary' && r.country === 'DE')).toBe(true);
  });

  it('gives every m+NN row the factor 100, datum NN and value_kind level, and no gauge zero', () => {
    const level = rows.filter((r) => r.native_unit === 'm+NN');
    expect(level).toHaveLength(9);
    for (const r of level) {
      expect([r.id, r.quantity, r.to_canonical, r.datum, r.value_kind, r.gauge_zero]).toEqual([
        r.id,
        'H',
        100,
        'NN',
        'level',
        [],
      ]);
      expect(r.native_step).toBe('PT1M');
    }
  });

  it('gives every cm row the factor 1 and value_kind stage, and every Q row m³/s with no datum', () => {
    const stage = rows.filter((r) => r.native_unit === 'cm');
    expect(stage).toHaveLength(189);
    expect(stage.every((r) => r.to_canonical === 1 && r.value_kind === 'stage' && r.quantity === 'H')).toBe(true);
    const discharge = rows.filter((r) => r.quantity === 'Q');
    for (const r of discharge) {
      expect([r.id, r.native_unit, r.to_canonical, r.value_kind, r.datum, r.gauge_zero]).toEqual([
        r.id,
        'm³/s',
        1,
        null,
        null,
        [],
      ]);
      expect(r.expected_threshold_source).toBeNull();
    }
  });

  it('takes the gauge zero from the meta call: 181 stage rows carry one, 8 do not', () => {
    const stage = rows.filter((r) => r.native_unit === 'cm');
    expect(stage.filter((r) => r.gauge_zero.length === 1)).toHaveLength(181);
    const without = stage.filter((r) => r.gauge_zero.length === 0);
    expect(without).toHaveLength(8);
    expect(without.every((r) => r.datum === null)).toBe(true);
    for (const r of stage.filter((x) => x.gauge_zero.length === 1)) {
      expect([r.id, r.gauge_zero[0]?.datum, r.gauge_zero[0]?.valid_to]).toEqual([r.id, r.datum, null]);
    }
  });

  it('derives the steps from the equidistance: expected 15 min below 5, stale after max(3 steps, 45 min)', () => {
    const steps = new Set(rows.map((r) => `${r.native_step} ${r.expected_step} ${r.staleness_limit}`));
    expect([...steps].sort()).toEqual([
      'PT10M PT10M PT45M',
      'PT15M PT15M PT45M',
      'PT1M PT15M PT45M',
      'PT5M PT5M PT45M',
    ]);
  });

  it('leaves 29 stations without coordinates and one without km', () => {
    const noCoordinates = rows.filter((r) => r.lon === null || r.lat === null);
    expect(stationIds(noCoordinates).size).toBe(29);
    expect(noCoordinates.every((r) => r.lon === null && r.lat === null)).toBe(true);
    expect(rows.filter((r) => r.km === null).map((r) => r.id)).toEqual(['de.wsv.3730001']);
  });

  it('flags only the nine Ems estuary gauges as tidal, and never impounded', () => {
    const tidal = rows.filter((r) => r.flags.tidal === true);
    expect([...stationIds(tidal)].sort()).toEqual(
      ['3790010', '3790020', '3910010', '3910020', '3950020', '3970010', '3990010', '3990020', '9340010'].map(
        (n) => `de.wsv.${n}`,
      ),
    );
    expect(tidal.every((r) => r.river === 'ems')).toBe(true);
    expect(rows.every((r) => r.flags.impounded === null && (r.flags.tidal === true || r.flags.tidal === null))).toBe(
      true,
    );
  });

  it('names DE-1 as the threshold source for the 65 H rows with an MNW or MHW', () => {
    expect(rows.filter((r) => r.expected_threshold_source === 'DE-1')).toHaveLength(65);
    expect(find('25700100').expected_threshold_source).toBe('DE-1');
    expect(find('3790010').expected_threshold_source).toBeNull();
  });

  it('gives each water its river slug and the km system named after the water', () => {
    expect(new Set(rows.map((r) => r.river))).toEqual(
      new Set(['rhine', 'moselle', 'saar', 'main', 'neckar', 'lahn', 'ruhr', 'ems', 'dortmund-ems-kanal']),
    );
    expect(find('25700100')).toMatchObject({
      water_name: 'RHEIN',
      km: { system: 'RHEIN-km (PEGELONLINE)', value: 546.23 },
    });
    expect(find('27600090').km).toEqual({ system: 'RUHR-km (PEGELONLINE)', value: 2.961 });
  });

  describe('against the catalogue', () => {
    it('every gauge zero the catalogue prints for a tier-1 or mirror gauge is the one in the file', () => {
      // [number, PNP in m, valid from where §3.1/§3.2 give it]
      const printed: [string, number, string?][] = [
        ['23300130', 217.291, '2018-11-01'],
        ['23300900', 133.02],
        ['23500600', 110.019],
        ['23700200', 97.721, '2017-07-18'],
        ['23700600', 88.467],
        ['23700700', 85.117],
        ['23900200', 84.112],
        ['25100100', 78.373, '2019-11-01'],
        ['25100300', 77.562],
        ['25300200', 76.185],
        ['25700100', 67.669],
        ['25900700', 57.692],
        ['27100400', 51.504],
        ['2710080', 42.713],
        ['2730010', 35.038, '2019-11-01'],
        ['2750010', 24.529],
        ['2770010', 16.106],
        ['2770040', 11.206],
        ['2790010', 8.743],
        ['2790020', 7.998, '2019-11-01'],
        ['23800100', 245.86],
        ['23800500', 159.37],
        ['23800690', 119.71],
        ['23800760', 103.22],
        ['23800900', 84.787],
        ['24300600', 164.511],
        ['24700404', 90.626],
        ['24900108', 82.879],
        ['25800200', 134.993],
        ['25800600', 86.4],
        ['26100100', 138.491, '2019-01-01'],
        ['26500100', 121.013],
        ['26900400', 77.032],
        ['26400100', 189.731],
        ['26400220', 183.228, '2024-11-13'],
        ['26400550', 165.491],
        ['2769510000100', 60.384, '2011-11-01'],
        ['2310010', 240, '2010-02-01'],
      ];
      expect(printed).toHaveLength(38);
      for (const [number, value, validFrom] of printed) {
        const zero = find(number).gauge_zero[0];
        expect([number, zero?.value_m, validFrom === undefined ? undefined : zero?.valid_from]).toEqual([
          number,
          value,
          validFrom,
        ]);
      }
    });

    it('Kaub 25700100: gauge zero 67.669 NHN, 15 min', () => {
      const kaub = find('25700100');
      expect(kaub).toMatchObject({ name: 'KAUB', datum: 'NHN', native_step: 'PT15M', tier: 1 });
      expect(kaub.gauge_zero.map((g) => [g.value_m, g.datum])).toEqual([[67.669, 'NHN']]);
      expect(kaub.provider_key).toBe('1d26e504-7f9e-480a-b52c-5932be6549ab/W');
    });

    it('Köln 2730010: gauge zero 35.038 NHN valid from 2019-11-01', () => {
      expect(find('2730010').gauge_zero).toEqual([
        { value_m: 35.038, datum: 'NHN', valid_from: '2019-11-01', valid_to: null },
      ]);
    });

    it('Basel-Rheinhalle 2310010: a CH mirror with gauge zero 240.0 LN02 since 2010-02-01', () => {
      const basel = find('2310010');
      expect(basel).toMatchObject({ country: 'CH', role: 'mirror', datum: 'LN02', native_unit: 'cm' });
      expect(basel.gauge_zero).toEqual([{ value_m: 240, datum: 'LN02', valid_from: '2010-02-01', valid_to: null }]);
    });

    it('Emmerich 2790020: UUID 9598e4cb-…, gauge zero 7.998 NHN valid from 2019-11-01, H and Q', () => {
      const emmerich = find('2790020');
      expect(emmerich.provider_key).toBe('9598e4cb-0849-401e-bba0-689234b27644/W');
      expect(find('2790020', 'Q').provider_key).toBe('9598e4cb-0849-401e-bba0-689234b27644/Q');
      expect(emmerich.gauge_zero).toEqual([{ value_m: 7.998, datum: 'NHN', valid_from: '2019-11-01', valid_to: null }]);
    });

    it('Ruhrwehr OW 27600090: unit m+NN, native step PT1M, expected step PT15M', () => {
      expect(find('27600090')).toMatchObject({
        native_unit: 'm+NN',
        to_canonical: 100,
        value_kind: 'level',
        datum: 'NN',
        native_step: 'PT1M',
        expected_step: 'PT15M',
        staleness_limit: 'PT45M',
        tier: 1,
      });
    });

    it('Stadtbredimus UP 26100130: tier 1, and no gauge zero because PEGELONLINE has none', () => {
      expect(find('26100130')).toMatchObject({ tier: 1, datum: null, gauge_zero: [] });
    });

    it('Alken 26900510 has a Q row only; Mannheim 23700700 has an H row only', () => {
      expect(rows.filter((r) => r.provider_code === '26900510').map((r) => r.quantity)).toEqual(['Q']);
      expect(rows.filter((r) => r.provider_code === '23700700').map((r) => r.quantity)).toEqual(['H']);
    });

    it('Lobith and Pannerdense Kop are NL mirrors with no gauge zero and no thresholds', () => {
      for (const number of ['2790050', '2790060']) {
        expect(find(number)).toMatchObject({
          country: 'NL',
          role: 'mirror',
          gauge_zero: [],
          expected_threshold_source: null,
        });
      }
    });

    it('keeps the third-party NEUWIED STADT gauge a primary tier-2 row, off until the owner verifies its licence', () => {
      expect(find('27100370')).toMatchObject({
        name: 'NEUWIED STADT',
        role: 'primary',
        tier: 2,
        first_release: false,
        audience: 'off',
        licence_gate: 'withheld',
      });
    });
  });
});

describe('scripts/gen-de1-stations.ts fails loudly', () => {
  type Basin = {
    number: string;
    agency: string;
    uuid: string;
    water: { shortname: string };
    timeseries: Record<string, unknown>[];
  }[];
  const mutated = (change: (basin: Basin) => void) => {
    const basin = structuredClone(inputs.basin) as Basin;
    change(basin);
    return () => run(basin);
  };
  const station = (basin: Basin, number: string) => {
    const found = basin.find((s) => s.number === number);
    if (found === undefined) throw new Error(`no fixture station ${number}`);
    return found;
  };
  const series = (basin: Basin, number: string, shortname: string) => {
    const found = station(basin, number).timeseries.find((t) => t.shortname === shortname);
    if (found === undefined) throw new Error(`no fixture series ${number}/${shortname}`);
    return found;
  };

  it('on a unit it does not know', () => {
    expect(mutated((b) => Object.assign(series(b, '25700100', 'W'), { unit: 'ft' }))).toThrow(
      /25700100 W: unknown unit "ft"/,
    );
    expect(mutated((b) => Object.assign(series(b, '25700100', 'Q'), { unit: 'l/s' }))).toThrow(
      /25700100 Q: unknown unit "l\/s"/,
    );
  });

  it('on a gauge-zero unit it does not know', () => {
    const meta = structuredClone(inputs.meta) as {
      uuid: string;
      timeseries: { shortname: string; gaugeZero?: { unit: string } }[];
    }[];
    const kaub = meta
      .find((s) => s.uuid === '1d26e504-7f9e-480a-b52c-5932be6549ab')
      ?.timeseries.find((t) => t.shortname === 'W');
    if (kaub?.gaugeZero === undefined) throw new Error('no Kaub gauge zero in the meta fixture');
    kaub.gaugeZero.unit = 'm ü. A.';
    expect(() => run(inputs.basin, meta)).toThrow(/25700100 W: unknown gauge-zero unit "m ü. A."/);
  });

  it('on an agency it does not know', () => {
    expect(mutated((b) => (station(b, '25700100').agency = 'NEUES AMT'))).toThrow(/new agency: review "NEUES AMT"/);
  });

  it('on a non-WSV agency whose gauge is not a listed mirror', () => {
    expect(mutated((b) => (station(b, '25700100').agency = 'RIJKSWATERSTAAT'))).toThrow(/must be a listed mirror/);
  });

  it('on a mirror whose UUID changed, and on a mirror that vanished', () => {
    expect(mutated((b) => (station(b, '2790050').uuid = '00000000-0000-4000-8000-000000000000'))).toThrow(
      /mirror 2790050: UUID/,
    );
    expect(
      mutated((b) =>
        b.splice(
          b.findIndex((s) => s.number === '3329'),
          1,
        ),
      ),
    ).toThrow(/mirror 3329 is not in the basin fixture/);
  });

  it('on a tier-1 station whose UUID changed, or that vanished', () => {
    expect(mutated((b) => (station(b, '25700100').uuid = '00000000-0000-4000-8000-000000000000'))).toThrow(
      /tier-1 station 25700100: UUID/,
    );
    expect(
      mutated((b) =>
        b.splice(
          b.findIndex((s) => s.number === '2730010'),
          1,
        ),
      ),
    ).toThrow(/tier-1 station 2730010 is not in the basin fixture/);
  });

  it('on a water it does not know, and on an equidistance that is not whole minutes', () => {
    expect(mutated((b) => (station(b, '25700100').water.shortname = 'ODER'))).toThrow(/unknown water ODER/);
    expect(mutated((b) => Object.assign(series(b, '25700100', 'W'), { equidistance: 7.5 }))).toThrow(
      /whole number of minutes/,
    );
  });

  it('on a payload that is not the expected shape', () => {
    expect(() => run({}, inputs.meta)).toThrow(/basin: expected an array/);
    expect(() => run(inputs.basin, [])).toThrow(/not in the meta fixture/);
  });

  it('but takes an RWS placeholder gauge as a NL mirror when it is present', () => {
    const basin = structuredClone(inputs.basin) as Basin;
    const meta = structuredClone(inputs.meta) as { uuid: string }[];
    const lobith = station(basin, '2790050');
    const placeholder = {
      ...structuredClone(lobith),
      number: '123456781',
      uuid: '11111111-1111-4111-8111-111111111111',
    };
    basin.push(placeholder);
    const metaLobith = meta.find((s) => s.uuid === lobith.uuid);
    if (metaLobith === undefined) throw new Error('no Lobith in the meta fixture');
    meta.push({ ...structuredClone(metaLobith), uuid: placeholder.uuid });
    const made = StationsFile.parse(parse(run(basin, meta))).stations.filter((s) => s.provider_code === '123456781');
    expect(made.map((s) => [s.role, s.country, s.tier])).toEqual([['mirror', 'NL', 2]]);
  });
});
