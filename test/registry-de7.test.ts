import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type PublicStation, SourcesFile, StationsFile, validateStations } from '../packages/contracts/src/index.ts';
import { generate, type Inputs, OUTPUT, readInputs } from '../scripts/gen-de7-stations.ts';
import { repoRoot } from './catalogue.ts';

// registry/stations/de-7.yaml is generated (scripts/gen-de7-stations.ts) from the recorded messwerte.txt (which gauges
// deliver, and at what step), the recorded OpenHygon station file (names, coordinates, warning levels) and the recorded
// hydro file (gauge zero, operator): the committed file is exactly the generator's output, and it holds what the
// catalogue (§2.3, §3) says about the NRW gauges.

const committed = readFileSync(OUTPUT, 'utf8');
const inputs = await readInputs();
const run = (change: Partial<Inputs> = {}) => generate({ ...inputs, ...change });
const sources = SourcesFile.parse(parse(readFileSync(`${repoRoot}registry/sources.yaml`, 'utf8'))).sources;
const rows = StationsFile.parse(parse(committed)).stations.filter((s): s is PublicStation => s.audience !== 'owner');
const de1Codes = new Set(
  (
    parse(readFileSync(`${repoRoot}registry/stations/de-1.yaml`, 'utf8')) as { stations: { provider_code: string }[] }
  ).stations.map((s) => s.provider_code),
);
const find = (no: string) => {
  const row = rows.find((r) => r.provider_code === no);
  if (row === undefined) throw new Error(`no DE-7 row ${no}`);
  return row;
};
const flat = committed.replace(/\n#\s+/g, ' ');

// Catalogue §3.1, §3.3, §3.5 and §3.6 (bold) plus the most downstream NRW gauge of a river with none in bold.
const TIER1 = [
  '2829100000100', // Stah (Rur)
  '2849900000100', // Landesgrenze (Niers)
  '2869500000200', // Goch (Niers)
  '3190000000100', // Haskenau (Ems)
  '9281700000200', // Isselburg (Bocholter Aa)
  '9282570000100', // Rhedebruegge (Issel / Bocholter Aa)
  '9284730000100', // Ammeloe (Berkel)
  '9286190000100', // Bilk (Vechte)
  '9286455000200', // Gronau (Dinkel)
];
const PLACEHOLDERS = ['1234567', '123456', '1234512345'];
const THIRD_PARTY = ['2761150000100', '2766645000100', '2768529000200', '2768784000200'];

describe('registry/stations/de-7.yaml', { timeout: 30_000 }, () => {
  it('is exactly what the generator writes from its inputs', () => {
    expect(committed).toBe(run());
  });

  it('is deterministic: the same input gives the same bytes and no timestamp', () => {
    expect(run()).toBe(run());
    expect(committed.slice(committed.indexOf('\nstations:'))).not.toMatch(/\d{2}:\d{2}/);
  });

  it('is unchanged by a YAML 1.1 reader (13-digit numbers are quoted)', () => {
    expect(parse(committed, { version: '1.1' })).toEqual(parse(committed));
  });

  it('validates against the real sources with no problem', () => {
    expect(validateStations(parse(committed), sources).problems).toEqual([]);
  });

  it('names its three inputs with recorded_at and sha256 in the header', () => {
    expect(inputs.files.map((f) => f.path)).toEqual([
      'apps/server/src/adapters/de-7/fixtures/de-7-messwerte.raw',
      'apps/server/src/adapters/de-8/fixtures/de-8-stations.raw',
      'apps/server/src/adapters/de-8/fixtures/de-8-hydro.raw',
    ]);
    for (const f of inputs.files) {
      expect(committed).toContain(`${f.path}  recorded_at ${f.recorded_at}  sha256 ${f.sha256}`);
    }
  });

  it('holds one H row per gauge that delivers in messwerte.txt: 251 rows, placeholders left out', () => {
    expect(inputs.readings.size).toBe(252);
    expect(rows).toHaveLength(251);
    expect(rows.map((r) => r.provider_code)).toEqual(
      [...inputs.readings.keys()].filter((no) => !PLACEHOLDERS.includes(no)).sort(),
    );
    for (const r of rows) {
      expect(r).toMatchObject({
        id: `de.lanuk.${r.provider_code}`,
        source: 'DE-7',
        provider_key: `${r.provider_code}/W`,
        water_name: null,
        country: 'DE',
        quantity: 'H',
        role: 'primary',
        river: null,
        km: null,
        flags: { tidal: null, impounded: null },
        native_unit: 'cm',
        to_canonical: 1,
        value_kind: 'stage',
        staleness_limit: 'PT2H',
        expected_forecast_source: null,
        licence_gate: 'open',
        audience: 'public',
        datum: 'NHN',
      });
    }
  });

  it('is ordered by station number as a string', () => {
    const codes = rows.map((r) => r.provider_code);
    expect(codes).toEqual([...codes].sort());
  });

  it('keeps the placeholders out, the 10-digit real station in, and registers no DE-1 (WSV) station number', () => {
    for (const no of PLACEHOLDERS) expect(rows.some((r) => r.provider_code === no)).toBe(false);
    expect(inputs.readings.has('1234512345')).toBe(true);
    expect(find('2768898001')).toMatchObject({ id: 'de.lanuk.2768898001', name: 'Haspertalsperre_Zu' });
    expect(de1Codes.size).toBeGreaterThan(100);
    expect(rows.filter((r) => de1Codes.has(r.provider_code))).toEqual([]);
    expect(flat).toContain('the placeholder numbers 1234567, 123456, 1234512345');
  });

  it('marks exactly the nine catalogue gauges as tier 1 and first_release, every other row tier 2', () => {
    const tier1 = rows.filter((r) => r.tier === 1);
    expect(tier1.map((r) => r.provider_code)).toEqual([...TIER1].sort());
    expect(tier1.every((r) => r.first_release)).toBe(true);
    expect(rows.filter((r) => r.tier === 2)).toHaveLength(242);
    expect(rows.filter((r) => r.tier === 2).every((r) => !r.first_release)).toBe(true);
    expect(find('2829100000100')).toMatchObject({ name: 'Stah', gauge_zero: [{ value_m: 29.938 }] });
  });

  it('takes the name verbatim and the WGS84 position from the station file', () => {
    const master = new Map(inputs.stations.map((s) => [s.no, s]));
    for (const r of rows) {
      const s = master.get(r.provider_code);
      expect([r.id, r.name, r.lon, r.lat]).toEqual([r.id, s?.name, s?.lon, s?.lat]);
    }
    expect(find('9282570000100').name).toBe('Rhedebruegge');
  });

  it('states the step of each gauge as its modal gap: PT15M for 199 gauges, PT5M for 52', () => {
    const steps = new Map<string, string>();
    for (const [no, times] of inputs.readings) {
      let five = 0;
      let fifteen = 0;
      let other = 0;
      for (let i = 1; i < times.length; i++) {
        const gap = ((times[i] ?? 0) - (times[i - 1] ?? 0)) / 60_000;
        if (gap === 5) five += 1;
        else if (gap === 15) fifteen += 1;
        else other += 1;
      }
      expect(Math.max(five, fifteen), no).toBeGreaterThan(other);
      steps.set(no, five > fifteen ? 'PT5M' : 'PT15M');
    }
    for (const r of rows)
      expect([r.id, r.native_step, r.expected_step]).toEqual([
        r.id,
        steps.get(r.provider_code),
        steps.get(r.provider_code),
      ]);
    expect(rows.filter((r) => r.native_step === 'PT5M')).toHaveLength(52);
    expect(rows.filter((r) => r.native_step === 'PT15M')).toHaveLength(199);
  });

  it('names DE-7 as the threshold source where LANUV_Info_1 is stated (104 gauges), else none', () => {
    const text = readFileSync(`${repoRoot}apps/server/src/adapters/de-8/fixtures/de-8-stations.raw`, 'utf8').split(
      '\n',
    );
    const info = new Map(
      text
        .slice(1)
        .filter((l) => l !== '')
        .map((l) => {
          const c = l.replace(/\r$/, '').split(';');
          return [c[3], c[6] !== ''] as const;
        }),
    );
    for (const r of rows)
      expect([r.id, r.expected_threshold_source]).toEqual([r.id, info.get(r.provider_code) ? 'DE-7' : null]);
    expect(rows.filter((r) => r.expected_threshold_source === 'DE-7')).toHaveLength(104);
    expect(find('9284730000100').expected_threshold_source).toBe('DE-7');
    expect(find('2849900000100').expected_threshold_source).toBeNull();
  });

  it('takes the gauge zero (NHN, no validity dates) from the hydro file; none where the gauge is not in it', () => {
    const hydro = new Map(inputs.hydro.map((h) => [h.id, h]));
    for (const r of rows) {
      const h = hydro.get(r.provider_code);
      expect([r.id, r.gauge_zero]).toEqual([
        r.id,
        h?.zero == null ? [] : [{ value_m: h.zero, datum: 'NHN', valid_from: null, valid_to: null }],
      ]);
    }
    expect(rows.filter((r) => r.gauge_zero.length === 0)).toHaveLength(32);
    expect(rows.filter((r) => r.gauge_zero.length === 1)).toHaveLength(219);
  });

  it('lists the stations without readings and the third-party operators in the header, as [U] items', () => {
    expect(flat).toContain('without readings in the recording (not registered): 2766929300099, 2825320000100.');
    expect(rows.some((r) => ['2766929300099', '2825320000100'].includes(r.provider_code))).toBe(false);
    const hydro = new Map(inputs.hydro.map((h) => [h.id, h]));
    const third = rows.filter(
      (r) => hydro.has(r.provider_code) && hydro.get(r.provider_code)?.operator !== 'LANUV, NRW',
    );
    expect(third.map((r) => r.provider_code)).toEqual(THIRD_PARTY);
    expect(flat).toContain(
      '[U] third-party operators: the hydro file names 4 registered gauges whose operator is not "LANUV, NRW":',
    );
    for (const r of third) expect(flat).toContain(`${r.provider_code} (${hydro.get(r.provider_code)?.operator})`);
    expect(flat).toContain('and 32 registered gauges are not in the hydro file (operator unknown)');
  });
});

describe('scripts/gen-de7-stations.ts fails loudly', { timeout: 30_000 }, () => {
  const readings = (change: (m: Map<string, number[]>) => void) => {
    const copy = new Map(inputs.readings);
    change(copy);
    return copy;
  };
  const times = (no: string) => {
    const t = inputs.readings.get(no);
    if (t === undefined) throw new Error(`no readings ${no}`);
    return t;
  };

  it('on a station in messwerte.txt that the station file does not list (a placeholder is exempt)', () => {
    expect(() => run({ stations: inputs.stations.filter((s) => s.no !== '2581119000100') })).toThrow(
      /stations in messwerte\.txt that the station file does not list: 2581119000100/,
    );
    expect(() => run({ stations: inputs.stations.filter((s) => s.no !== '1234512345') })).not.toThrow();
    expect(() => run({ readings: readings((m) => m.set('2581119999999', times('2581119000100'))) })).toThrow(
      /does not list: 2581119999999/,
    );
  });

  it('on a DE-7 station number that DE-1 registers (a WSV gauge)', () => {
    expect(() => run({ de1: new Set([...inputs.de1, '2581119000100']) })).toThrow(
      /DE-7 station numbers that DE-1 registers \(WSV gauges\): 2581119000100/,
    );
  });

  it('on a modal step other than 5 or 15 minutes, or no step at all', () => {
    const seven = Array.from({ length: 20 }, (_, i) => i * 7 * 60_000);
    expect(() => run({ readings: readings((m) => m.set('2581119000100', seven)) })).toThrow(
      /station 2581119000100: the modal step is 7 min, outside PT5M, PT15M/,
    );
    expect(() => run({ readings: readings((m) => m.set('2581119000100', [1])) })).toThrow(/the modal step is unknown/);
    expect(() => run({ readings: readings((m) => m.set('2581119000100', [0, 600_000, 1_200_000])) })).toThrow(
      /the modal step is 10 min/,
    );
  });

  it('on a tier-1 gauge that is missing, has no readings or has another name', () => {
    expect(() => run({ stations: inputs.stations.filter((s) => s.no !== '2829100000100') })).toThrow(
      /tier-1 station 2829100000100 is not in the station file/,
    );
    expect(() => run({ readings: readings((m) => m.delete('2829100000100')) })).toThrow(
      /tier-1 station 2829100000100 has no readings/,
    );
    expect(() =>
      run({ stations: inputs.stations.map((s) => (s.no === '2829100000100' ? { ...s, name: 'Elsewhere' } : s)) }),
    ).toThrow(/tier-1 station 2829100000100 is "Elsewhere" in the station file, expected "Stah"/);
  });

  it('on a station or hydro row twice, and on a name that breaks the label rule', () => {
    const first = inputs.stations[0];
    if (first === undefined) throw new Error('no station');
    expect(() => run({ stations: [...inputs.stations, first] })).toThrow(/station file: \S+ twice/);
    const hydro = inputs.hydro[0];
    if (hydro === undefined) throw new Error('no hydro row');
    expect(() => run({ hydro: [...inputs.hydro, hydro] })).toThrow(/hydro file: \S+ twice/);
    expect(() =>
      run({ stations: inputs.stations.map((s) => (s.no === '2581119000100' ? { ...s, name: 'Bad‮Name' } : s)) }),
    ).toThrow(/station 2581119000100 name: a control or format character/);
    expect(() =>
      run({ stations: inputs.stations.map((s) => (s.no === '2581119000100' ? { ...s, name: 'x'.repeat(201) } : s)) }),
    ).toThrow(/station 2581119000100 name: longer than 200 characters/);
  });
});
