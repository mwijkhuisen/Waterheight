import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { StationsFile } from '@rws/contracts';
import {
  CSV_MAX_COLUMNS,
  CSV_MAX_FIELD,
  checkRun,
  FORECAST_FLAGS,
  FORECAST_SOURCES,
  type ForecastPoint,
  type Normalised,
  SchemaDrift,
} from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { isSixWeek, normalise, numberOf, SOURCE, TIME } from '../../src/adapters/de-3/normalise.ts';
import { LEVELS, MAX_ROWS, parseTable } from '../../src/adapters/de-3/parse.ts';
import { REGISTRY_DIR, readSeed } from '../../src/capture/specs.ts';
import type { LoadContext } from '../../src/load/adapters.ts';
import { ADAPTER } from '../../src/load/wire/de-3.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// DE-3 BfG 14-day quantile forecast (owner audience, catalogue §2.2): parse + normalise (through the loader entry,
// load/wire/de-3.ts) of the synthetic fixtures equal their goldens (invariant 9: owner fixtures are synthetic, real
// structure, generated values), the DST proof, the structure checks, the censored `---`, the series lookup and the
// property tests. `UPDATE_GOLDEN=1` rewrites goldens.

const root = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DECL = FORECAST_SOURCES['DE-3'];
const { CENSORED, ORDER } = FORECAST_FLAGS;
const de1 = registryOf('DE-1');
const wire = ADAPTER.specs['de-3-files'];

const EMMERICH = '14-Tage-Vorhersage/Emmerich_Quantile_2790020.csv';
const EMMERICH_UUID = '9598e4cb-0849-401e-bba0-689234b27644';
const KAUB_UUID = '1d26e504-7f9e-480a-b52c-5932be6549ab';

type Golden = { forecasts: Normalised['forecasts']; dropped: Normalised['dropped']; unknown: number };
function golden(name: string, actual: Golden): Golden {
  const url = goldenUrl('DE-3', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const ctx = (variant: string, patch: Partial<LoadContext> = {}): LoadContext => ({
  registry: new Map(),
  fetchedAt: Date.parse('2030-01-02T10:00:00Z'),
  variant,
  unitMismatch: new Set(),
  refRegistries: new Map([['DE-1', de1]]),
  ...patch,
});
/** The loader entry: parse, normalise and the DE-1 lookup, as the loader runs a payload. */
const load = async (body: Uint8Array, variant: string, patch: Partial<LoadContext> = {}): Promise<Normalised> => {
  if (wire === undefined) throw new Error('no de-3-files loader');
  return wire.run(body, ctx(variant, patch));
};
const read = (name: string) => rawFixture('DE-3', name);
const variantOf = (name: string) => (read(name).meta as unknown as { variant: string }).variant;
const keyOf = (n: string) => (n === '2790020' ? EMMERICH_UUID : n === '25700100' ? KAUB_UUID : undefined);
const projected = (n: Normalised): Golden => ({ forecasts: n.forecasts, dropped: n.dropped, unknown: n.unknown });
/** The loader's check of a run, fetched ten hours after its first valid time. */
const checked = (n: Normalised) => {
  const r = n.forecasts?.[0];
  if (r === undefined) throw new Error('no run');
  return checkRun(r, Date.parse(r.points[0]?.ts as string) + 10 * HOUR, DECL);
};

const FIXTURES = [
  'de-3-files.synthetic',
  'de-3-files-emmerich.synthetic',
  'de-3-files-kaub.synthetic',
  'de-3-files-ruhrort-censored.synthetic',
  'de-3-files-oestrich-unknown.synthetic',
  'de-3-files-dst-fall-back.synthetic',
  'de-3-files-dst-spring-forward.synthetic',
] as const;

const HEAD = [
  '# Probabilistische Wasserstandsvorhersage vom 2030-01-01 GMT+1',
  '# Quelle: Bundesanstalt fuer Gewaesserkunde <vorhersage@bafg.de>',
  '# Vorhersagetage 1 - 14 Tagesmittelwerte',
  "# Keine Veroeffentlichung von Werten > 999 cm (Wert '---')",
  '# !!!! Zeitstempel Beginn des Zeitschritts !!!!',
  'Teststation ',
];
const HEADER = `Datum;${LEVELS.map((l) => `${l}%`).join(';')}`;
const FIRST = Date.UTC(2030, 0, 2);
const pad = (n: number) => String(n).padStart(2, '0');
/** `dd.mm.yyyy 00:00` of day `i` after 2030-01-02. */
const label = (i: number, from = FIRST) => {
  const d = new Date(from + i * DAY);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} 00:00`;
};
type Cells = (number | null)[];
const rowText = (cells: Cells, i: number) =>
  [label(i), ...cells.map((c) => (c === null ? '---' : String(c)))].join(';');
/** A file of the real structure, CRLF line ends; every line replaceable. */
const lines = (rows: Cells[], head: string[] = HEAD, header = HEADER) => [...head, header, ...rows.map(rowText)];
const text = (rows: Cells[], eol = '\r\n') => `${lines(rows).join(eol)}${eol}`;
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
/** Thirteen cells 100, 101, … (the column index shows in the value). */
const ramp = (n = 1): Cells[] => Array.from({ length: n }, () => LEVELS.map((_, i) => 100 + i));
const table = (s: string) => parseTable(bytes(s));
const run = (rows: Cells[], variant = EMMERICH): Normalised => normalise(table(text(rows)), { variant, keyOf });
const drift = (f: () => unknown, code: string, path?: string) =>
  expect(f).toThrow(expect.objectContaining(path === undefined ? { code } : { code, path }));

describe('golden files (synthetic: owner audience)', () => {
  for (const name of FIXTURES) {
    it(`${name}: parse + normalise equals the golden, and the run passes the core bounds`, async () => {
      const n = await load(new Uint8Array(read(name).body), variantOf(name));
      const out = projected(n);
      expect(out).toEqual(golden(name, out));
      // The loader's own check leaves a run whole (a censored point is kept, none is a gap): nothing is dropped.
      if (n.forecasts !== undefined) {
        const c = checked(n);
        expect(c.dropped).toEqual({});
        expect(c.run?.points).toHaveLength(n.forecasts[0]?.points.length as number);
      }
    });
  }

  it('a normal run: 14 daily points, the DE-1 stage series of Emmerich, no issue time, p50 is the value', async () => {
    const out = await load(new Uint8Array(read('de-3-files-emmerich.synthetic').body), EMMERICH);
    expect(out.dropped).toEqual({});
    expect(out.unknown).toBe(0);
    expect(out.obs).toEqual([]);
    expect(out.forecasts).toHaveLength(1);
    const [r] = out.forecasts ?? [];
    expect(r).toMatchObject({
      target: 'DE-1',
      series: `${EMMERICH_UUID}/W`,
      kind: 'quantiles',
      stepMs: DAY,
      issuedAt: null,
      providerSegmentEnd: null,
    });
    const pts = r?.points ?? [];
    expect(pts).toHaveLength(14);
    // 02.01.2030 00:00 CET is 2030-01-01T23:00Z; one UTC day apart.
    expect(pts[0]?.ts).toBe('2030-01-01T23:00:00.000Z');
    const ms = pts.map((p) => Date.parse(p.ts));
    expect(ms.every((t, i) => i === 0 || t - (ms[i - 1] as number) === DAY)).toBe(true);
    // Only the columns the forecast schema has, whole centimetres as published (negative levels occur), p50 = value.
    for (const p of pts) {
      expect(Object.keys(p).sort()).toEqual(['flags', 'p05', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95', 'ts', 'value']);
      expect(p.value).toBe(p.p50);
      expect(p.flags).toBe(0);
    }
    expect(pts.every((p) => [p.p05, p.p10, p.p25, p.p50, p.p75, p.p90, p.p95].every((v) => Number.isInteger(v)))).toBe(
      true,
    );
    expect(pts.some((p) => (p.p50 as number) < 0)).toBe(true);
  });

  it('the DST runs: 14 daily rows across 2026-10-25 and across 2027-03-28, in UTC one day apart, none repeated or missing', async () => {
    const cases = [
      // The label is CET all year (+01:00): the day of the fall-back starts at 23:00Z the day before, as every other.
      [
        'de-3-files-dst-fall-back.synthetic',
        '2026-10-19T23:00:00.000Z',
        '2026-10-24T23:00:00.000Z',
        '2026-10-25T23:00:00.000Z',
      ],
      [
        'de-3-files-dst-spring-forward.synthetic',
        '2027-03-22T23:00:00.000Z',
        '2027-03-27T23:00:00.000Z',
        '2027-03-28T23:00:00.000Z',
      ],
    ] as const;
    for (const [name, first, change, next] of cases) {
      const text = read(name).body.toString('latin1');
      const out = await load(new Uint8Array(read(name).body), variantOf(name));
      const pts = out.forecasts?.[0]?.points.map((p) => p.ts) ?? [];
      expect(pts).toHaveLength(14);
      expect(pts[0]).toBe(first);
      // The labels 25.10.2026 and 28.03.2027 sit in the files; the days around them are as long as any other.
      expect(text).toMatch(/^2[58]\.(?:10\.2026|03\.2027) 00:00;/m);
      const i = pts.indexOf(change);
      expect([name, i]).toEqual([name, 5]);
      expect(pts[i + 1]).toBe(next);
      const ms = pts.map((t) => Date.parse(t));
      expect(ms.every((t, k) => k === 0 || t - (ms[k - 1] as number) === DAY)).toBe(true);
      expect(new Set(pts).size).toBe(14);
      expect(checked(out).dropped).toEqual({});
    }
  });

  it('the P1 capture fixture is a normal file of the same structure (a validity fixture and a golden)', () => {
    expect(table(read('de-3-files.synthetic').body.toString('latin1')).rows).toHaveLength(14);
  });

  it('a file with `---`: the cell is null (never 0) and the point is CENSORED; a row of only `---` is kept', async () => {
    const name = 'de-3-files-ruhrort-censored.synthetic';
    const out = await load(new Uint8Array(read(name).body), variantOf(name));
    const pts = out.forecasts?.[0]?.points ?? [];
    expect(pts).toHaveLength(14);
    // Seven rows have a `---` in a kept column; the fifth row has one in the 60 % column only (dropped): no trace.
    expect(pts.map((p) => p.flags & CENSORED)).toEqual([...Array(7).fill(0), ...Array(7).fill(CENSORED)]);
    const nulls = (p: ForecastPoint) =>
      [p.p05, p.p10, p.p25, p.p50, p.p75, p.p90, p.p95].filter((v) => v === null).length;
    expect(pts.map(nulls)).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 5, 7, 7, 7]);
    expect(pts.slice(0, 7).every((p) => (p.flags & ~ORDER) === 0)).toBe(true);
    // Never 0: a `---` is absent, and the last three rows (only `---`) hold no value at all.
    expect(pts.slice(-3).flatMap((p) => [p.value, p.p05, p.p50, p.p95])).toEqual(Array(12).fill(null));
    expect(pts.at(-1)).toMatchObject({
      value: null,
      p05: null,
      p10: null,
      p25: null,
      p50: null,
      p75: null,
      p90: null,
      p95: null,
    });
    // The loader keeps every one of them (a censored all-null point is no gap).
    const c = checked(out);
    expect(c.dropped).toEqual({});
    expect(c.run?.points).toHaveLength(14);
    expect(c.run?.points.at(-1)?.v.every((v) => v === null)).toBe(true);
  });
});

describe('rules (synthetic)', () => {
  it('declares the label as the start of its interval at +01:00', () => {
    expect(TIME).toEqual({ kind: 'start-of-interval', offset: '+01:00' });
    expect(SOURCE).toBe('DE-3');
    expect(DECL).toMatchObject({ kind: 'quantiles', stepMs: DAY, horizonMs: 15 * DAY, units: { cm: ['H', 1] } });
  });

  it('23.09.2026 00:00 is 2026-09-22T23:00:00Z: the day that starts there', () => {
    const body = lines([ramp()[0] as Cells])
      .join('\r\n')
      .replace(label(0), '23.09.2026 00:00');
    const out = normalise(table(body), { variant: EMMERICH, keyOf });
    expect(out.forecasts?.[0]?.points[0]?.ts).toBe('2026-09-22T23:00:00.000Z');
  });

  it('thirteen percentile columns, seven kept as p05 p10 p25 p50 p75 p90 p95, six dropped; value is p50', () => {
    expect(LEVELS).toEqual([5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95]);
    const [p] = run(ramp()).forecasts?.[0]?.points ?? [];
    // Column i holds 100 + i: 5 % is 100, 10 % 101, (20 % 102 dropped), 25 % 103, (30, 40 dropped), 50 % 106,
    // (60, 70 dropped), 75 % 109, (80 % dropped), 90 % 111 and 95 % 112.
    expect(p).toEqual({
      ts: '2030-01-01T23:00:00.000Z',
      flags: 0,
      p05: 100,
      p10: 101,
      p25: 103,
      p50: 106,
      p75: 109,
      p90: 111,
      p95: 112,
      value: 106,
    });
    // p30 and p70 are LU-3's columns: no DE-3 value ever lands there.
    expect(p).not.toHaveProperty('p30');
    expect(p).not.toHaveProperty('p70');
  });

  it('`---` is null and CENSORED, never 0, in a kept column; in a dropped one it leaves no trace', () => {
    const row = ramp()[0] as Cells;
    const censored = (...at: number[]) =>
      run([row.map((c, i) => (at.includes(i) ? null : c))]).forecasts?.[0]?.points[0];
    expect(censored(12)).toMatchObject({ p95: null, p90: 111, flags: CENSORED });
    expect(censored(6)).toMatchObject({ p50: null, value: null, p25: 103, flags: CENSORED });
    expect(censored(0)).toMatchObject({ p05: null, p10: 101, flags: CENSORED });
    // 20, 30, 40, 60, 70 and 80 %: dropped columns.
    for (const dropped of [2, 4, 5, 7, 8, 10]) expect(censored(dropped)?.flags).toBe(0);
    expect(censored(12)?.p95).not.toBe(0);
    // A row of only `---`: every column null, CENSORED, and the loader keeps it; without CENSORED it would be a gap.
    const only = run([ramp()[0] as Cells, row.map(() => null)]);
    expect(only.forecasts?.[0]?.points[1]).toMatchObject({ flags: CENSORED, value: null, p05: null, p95: null });
    expect(checked(only).run?.points).toHaveLength(2);
    const bare = structuredClone(only);
    (bare.forecasts?.[0]?.points[1] as ForecastPoint).flags = 0;
    expect(checked(bare)).toMatchObject({ dropped: { gap: 1 } });
    // A file of only `---` rows is a run of censored points.
    expect(checked(run([row.map(() => null), row.map(() => null)])).run?.points).toHaveLength(2);
  });

  it('negative levels, zero and leading zeros are whole centimetres; `-0` is 0', () => {
    const [p] = run([[-12, -1, 0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 99999]]).forecasts?.[0]?.points ?? [];
    expect([p?.p05, p?.p10, p?.p25, p?.p50, p?.p95]).toEqual([-12, -1, 7, 10, 99999]);
    const zero = parseTable(bytes(text([LEVELS.map(() => 0)]).replaceAll(';0', ';-0')));
    expect(zero.rows[0]?.cells.every((c) => Object.is(c, 0))).toBe(true);
    expect(table(text([ramp()[0] as Cells]).replace(';100;', ';0100;')).rows[0]?.cells[0]).toBe(100);
  });

  it('crossed percentiles are stored as published and flagged ORDER by the core check, never reordered', () => {
    // 50 % below 25 %, and a decreasing 75 %.
    const crossed: Cells = [10, 20, 30, 40, 50, 60, 15, 80, 90, 85, 100, 110, 120];
    const out = run([crossed]);
    const [p] = out.forecasts?.[0]?.points ?? [];
    expect(p).toMatchObject({ p05: 10, p10: 20, p25: 40, p50: 15, p75: 85, p90: 110, p95: 120, flags: 0 });
    const c = checked(out).run?.points[0];
    expect(c?.flags).toBe(ORDER);
    // The canonical values stay in the columns of the file (value p05 p10 p25 p30 p50 p70 p75 p90 p95 vmin vmax): no sort.
    expect(c?.v).toEqual([15, 10, 20, 40, null, 15, null, 85, 110, 120, null, null]);
    // An ordered point is not flagged; a `---` column is skipped by the check (the others still count).
    expect(checked(run(ramp())).run?.points[0]?.flags).toBe(0);
    const partial = ramp()[0]?.map((c, i) => (i === 11 ? null : c)) as Cells;
    expect(checked(run([partial])).run?.points[0]?.flags).toBe(CENSORED);
    // The run itself carries no ORDER (a normaliser never sets it).
    expect(out.forecasts?.[0]?.points.every((q) => (q.flags & ORDER) === 0)).toBe(true);
  });

  it('every series of registry/seed/de-3.csv is a 14-day or a 6-week file; the 14-day ones are DE-1 stage series in cm', () => {
    const paths = readSeed(REGISTRY_DIR, 'de-3').map((r) => r.path as string);
    expect(paths).toHaveLength(23);
    const six = paths.filter((p) => isSixWeek(p));
    expect([paths.length - six.length, six.length]).toEqual([7, 16]);
    const rows = StationsFile.parse(parse(root('registry/stations/de-1.yaml'))).stations;
    for (const p of paths.filter((x) => !isSixWeek(x))) {
      const number = numberOf(p);
      const row = rows.find((r) => r.id === `de.wsv.${number}` && r.quantity === 'H');
      expect([p, row?.role, row?.native_unit, row?.to_canonical]).toEqual([p, 'primary', 'cm', 1]);
    }
  });

  it('the loader entry: the spec, its variant and the DE-1 reference, the DE-1 key of each of the seven stations', async () => {
    expect(Object.keys(ADAPTER.specs)).toEqual(['de-3-files']);
    expect([wire?.needsVariant, wire?.maxBytes, wire?.refTarget]).toEqual([true, 1024 * 1024, ['DE-1']]);
    const body = new Uint8Array(Buffer.from(text(ramp())));
    const rows = StationsFile.parse(parse(root('registry/stations/de-1.yaml'))).stations;
    for (const r of readSeed(REGISTRY_DIR, 'de-3').filter((x) => !isSixWeek(x.path as string))) {
      const path = r.path as string;
      const row = rows.find((s) => s.id === `de.wsv.${numberOf(path)}` && s.quantity === 'H');
      const out = await load(body, path);
      expect([path, out.forecasts?.[0]?.series, out.unknown]).toEqual([path, row?.provider_key, 0]);
      expect(out.forecasts?.[0]?.series).toMatch(/\/W$/);
    }
  });

  it('a number DE-1 does not register is unknown (counted, nothing guessed); so is a run with no registry at all', async () => {
    const body = new Uint8Array(Buffer.from(text(ramp(2))));
    const out = await load(body, '14-Tage-Vorhersage/Nirgendwo_Quantile_9999999.csv');
    expect(out).toMatchObject({ unknown: 1, dropped: {}, obs: [] });
    expect(out.forecasts).toBeUndefined();
    const bare = { registry: new Map(), fetchedAt: Date.parse('2030-01-02T10:00:00Z'), variant: EMMERICH };
    expect((await wire?.run(body, { ...bare, unitMismatch: new Set() }))?.unknown).toBe(1);
    expect((await load(body, EMMERICH, { refRegistries: new Map() })).unknown).toBe(1);
    // A stage series is the only target: a station with only a discharge series has none.
    const discharge = new Map([...de1].filter(([, s]) => s.quantity === 'Q'));
    expect((await load(body, EMMERICH, { refRegistries: new Map([['DE-1', discharge]]) })).unknown).toBe(1);
  });

  it('a 6-week file is not parsed and not drift: an empty result, whatever its body', async () => {
    for (const p of readSeed(REGISTRY_DIR, 'de-3')
      .map((r) => r.path as string)
      .filter((x) => x.startsWith('6-Wochen-Vorhersage/'))) {
      const out = await load(new Uint8Array(Buffer.from('Datum;QuansBox\r\n01.01.2030;1\r\n')), p);
      expect(out).toEqual({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0 });
    }
    // Not for a 14-day file: that body is read, and this one is no file of the structure.
    await expect(load(new Uint8Array(Buffer.from('Datum;QuansBox\r\n')), EMMERICH)).rejects.toThrow(SchemaDrift);
  });

  it('a variant that is no 14-day or 6-week path is drift (the variant is ours, never provider text)', async () => {
    const body = new Uint8Array(Buffer.from(text(ramp())));
    for (const bad of [
      '',
      'Emmerich_Quantile_2790020.csv',
      '14-Tage-Vorhersage/Emmerich_Quantile_2790020.csv ',
      '14-Tage-Vorhersage/Emmerich_Quantile_.csv',
      '14-Tage-Vorhersage/Emmerich_Quantile_2790020.txt',
      '14-Tage-Vorhersage/../Emmerich_Quantile_2790020.csv',
      '14-Tage-Vorhersage/index.html',
      '6-Wochen-Vorhersage/index.html',
      '6-Wochen-Vorhersage/../x.csv',
      '30-Tage-Vorhersage/Emmerich_Quantile_2790020.csv',
      `14-Tage-Vorhersage/${'a'.repeat(300)}_Quantile_2790020.csv`,
    ]) {
      await expect(load(body, bad)).rejects.toThrow(expect.objectContaining({ code: 'bad_variant' }));
      expect(() => normalise(table(text(ramp())), { variant: bad, keyOf })).toThrow(
        expect.objectContaining({ code: 'bad_variant' }),
      );
    }
  });

  it('a label that is no real date is drift in normalise, with the row’s place', () => {
    const t = table(text(ramp(3)).replace(label(1), '31.02.2030 00:00'));
    drift(() => normalise(t, { variant: EMMERICH, keyOf }), 'time_bad_format', 'rows.1');
    // A label with no time of day, another date format or a wrong separator never gets as far as normalise.
    for (const bad of ['02.01.2030', '2030-01-02 00:00', '02.01.2030 0:00', '02/01/2030 00:00', '02.01.30 00:00'])
      drift(() => table(text(ramp()).replace(label(0), bad)), 'time_bad_format', 'rows.0');
  });

  it('a file with no row is no run, only the drop count', () => {
    const out = normalise(table(text([])), { variant: EMMERICH, keyOf });
    expect(out.forecasts).toBeUndefined();
    expect(out.dropped).toEqual({ empty_run: 1 });
  });

  it('two rows at one instant are drift in the loader’s check, in any order of the file', () => {
    const rows = ramp(4);
    const same = table(text(rows).replace(label(3), label(1)));
    const [r] = normalise(same, { variant: EMMERICH, keyOf }).forecasts ?? [];
    expect(() => checkRun(r as NonNullable<typeof r>, FIRST, DECL)).toThrow(
      expect.objectContaining({ code: 'duplicate_ts' }),
    );
    // The rows of a file in reverse order are the same run once sorted; the adapter never sorts.
    const forward = normalise(table(text(rows)), { variant: EMMERICH, keyOf }).forecasts?.[0];
    const reversed = table([...HEAD, HEADER, ...rows.map(rowText).reverse()].join('\r\n'));
    const backward = normalise(reversed, { variant: EMMERICH, keyOf }).forecasts?.[0];
    expect(backward?.points.map((p) => p.ts)).toEqual(forward?.points.map((p) => p.ts).reverse());
    expect(checkRun(backward as NonNullable<typeof backward>, FIRST, DECL).run).toEqual(
      checkRun(forward as NonNullable<typeof forward>, FIRST, DECL).run,
    );
  });
});

describe('the structure of a file (drift)', () => {
  const good = lines(ramp(2));
  const join = (l: string[], eol = '\r\n') => `${l.join(eol)}${eol}`;

  it('a file of the real structure parses: CRLF or LF, a trailing blank line, a station name of any bytes', () => {
    expect(table(join(good)).rows).toHaveLength(2);
    expect(table(join(good, '\n')).rows).toHaveLength(2);
    expect(table(`${join(good)}\r\n\r\n`).rows).toHaveLength(2);
    expect(table(join(good).slice(0, -2)).rows).toHaveLength(2);
    expect(
      parseTable(
        new Uint8Array([
          ...bytes(HEAD.slice(0, 5).join('\r\n')),
          13,
          10,
          0xfc,
          0xe9,
          32,
          13,
          10,
          ...bytes(`${HEADER}\r\n`),
        ]),
      ).rows,
    ).toEqual([]);
  });

  it('a missing, an extra or a changed `#` line is drift, with the line', () => {
    for (let i = 0; i < 5; i++) {
      const without = [...good.slice(0, i), ...good.slice(i + 1)];
      expect(() => table(join(without))).toThrow(SchemaDrift);
      const changed = good.map((l, k) => (k === i ? `${l} ` : l));
      drift(() => table(join(changed)), 'comment_line', `lines.${i}`);
      const other = good.map((l, k) => (k === i ? '# synthetic-1' : l));
      drift(() => table(join(other)), 'comment_line', `lines.${i}`);
    }
    // One too many (before, among or after the five), none at all, and the five in another order.
    drift(() => table(join(['# extra', ...good])), 'comment_line', 'lines.0');
    drift(() => table(join([...good.slice(0, 3), '# extra', ...good.slice(3)])), 'comment_line', 'lines.3');
    drift(() => table(join([...good.slice(0, 5), '# extra', ...good.slice(5)])), 'station_line', 'lines.5');
    drift(() => table(join(good.slice(5))), 'comment_line', 'lines.0');
    drift(() => table(join([good[1], good[0], ...good.slice(2)] as string[])), 'comment_line', 'lines.0');
  });

  it('the offset is part of the structure: GMT+1 only (a provider that moves to GMT+2 is drift, never a shifted day)', () => {
    for (const other of ['GMT+2', 'GMT+0', 'GMT-1', 'GMT+01', 'MEZ', 'GMT+1:00', 'UTC+1'])
      drift(
        () => table(join(good.map((l, k) => (k === 0 ? l.replace('GMT+1', other) : l)))),
        'comment_line',
        'lines.0',
      );
  });

  it('the station line: present, one line, no `;`, at most 100 characters', () => {
    const at = (l: string) => join(good.map((x, k) => (k === 5 ? l : x)));
    expect(table(at('x'.repeat(100))).rows).toHaveLength(2);
    for (const bad of ['', '   ', 'x'.repeat(101), 'a;b', '# comment'])
      drift(() => table(at(bad)), 'station_line', 'lines.5');
    // No station line: the header is read as one.
    drift(() => table(join([...good.slice(0, 5), ...good.slice(6)])), 'station_line', 'lines.5');
  });

  it('the Datum header is exact: its name, its thirteen percentiles in order', () => {
    const head = (h: string) => join(good.map((l, k) => (k === 6 ? h : l)));
    drift(() => table(head(HEADER.replace('Datum', 'Date'))), 'csv_header');
    drift(() => table(head(HEADER.replace('95%', '99%'))), 'csv_header');
    drift(() => table(head(HEADER.replace('5%;10%', '10%;5%'))), 'csv_header');
    drift(() => table(head(HEADER.replace('95%', '95'))), 'csv_header');
    drift(() => table(head(HEADER.replace(';5%', ''))), 'csv_width');
    // A wrong column count in header and rows alike is still a wrong header.
    const narrow = [
      ...good.slice(0, 6),
      HEADER.split(';').slice(0, 12).join(';'),
      ...good.slice(7).map((l) => l.split(';').slice(0, 12).join(';')),
    ];
    drift(() => table(join(narrow)), 'csv_header');
    const wide = [...good.slice(0, 6), `${HEADER};99%`, ...good.slice(7).map((l) => `${l};5`)];
    drift(() => table(join(wide)), 'csv_header');
  });

  it('a row as wide as the header or csv_width; a row of the wrong width never loads', () => {
    drift(() => table(join(good.map((l, k) => (k === 7 ? l.split(';').slice(0, 13).join(';') : l)))), 'csv_width');
    drift(() => table(join(good.map((l, k) => (k === 7 ? `${l};5` : l)))), 'csv_width');
    // A trailing separator is one empty field too many: drift, not a quiet drop.
    drift(() => table(join(good.map((l, k) => (k === 7 ? `${l};` : l)))), 'csv_width');
  });

  it('a cell is an integer or `---`: anything else is drift at its row', () => {
    for (const bad of [
      '',
      ' ',
      '1.5',
      '1,5',
      'abc',
      '1e3',
      '-',
      '--',
      '----',
      '- 1',
      '+1',
      '123456',
      '0x10',
      'NaN',
      '1 2',
    ])
      drift(
        () => table(join(good.map((l, k) => (k === 8 ? l.replace(';100;', `;${bad};`) : l)))),
        'bad_value',
        'rows.1',
      );
  });

  it('a truncated file, an empty one and one with no header are drift', () => {
    drift(() => table(''), 'truncated', 'lines.0');
    drift(() => table(good.slice(0, 3).join('\r\n')), 'truncated');
    drift(() => table(good.slice(0, 5).join('\r\n')), 'truncated', 'lines.4');
    drift(() => table(join(good.slice(0, 5))), 'truncated', 'lines.5');
    drift(() => table(join(good.slice(0, 6))), 'csv_empty');
    // A row cut in the middle is a row too short.
    drift(() => table(good.join('\r\n').slice(0, -20)), 'csv_width');
  });

  it('the caps of the CSV scan: rows, columns, field size (catalogue §6.7)', () => {
    expect(MAX_ROWS).toBe(100);
    expect(table(text(ramp(MAX_ROWS))).rows).toHaveLength(MAX_ROWS);
    drift(() => table(text(ramp(MAX_ROWS + 1))), 'csv_rows');
    const wideHeader = `${HEADER}${';x'.repeat(CSV_MAX_COLUMNS)}`;
    drift(() => table(join([...good.slice(0, 6), wideHeader, good[7] as string])), 'csv_columns');
    const huge = '9'.repeat(CSV_MAX_FIELD + 1);
    drift(() => table(join(good.map((l, k) => (k === 7 ? l.replace(';100;', `;${huge};`) : l)))), 'csv_field');
    // A field at the cap is a value that is far too long: bad_value, not a pass.
    drift(
      () => table(join(good.map((l, k) => (k === 7 ? l.replace(';100;', `;${'9'.repeat(CSV_MAX_FIELD)};`) : l)))),
      'bad_value',
      'rows.0',
    );
    // An unterminated quote is no CSV.
    drift(() => table(join(good.map((l, k) => (k === 7 ? l.replace(';100;', ';"100;') : l)))), 'csv_quote');
  });
});

describe('properties', () => {
  const cell = fc.oneof(
    { weight: 6, arbitrary: fc.integer({ min: -9999, max: 99999 }) },
    { weight: 1, arbitrary: fc.constant(null) },
  );
  const rows = fc.array(fc.array(cell, { minLength: 13, maxLength: 13 }), { minLength: 1, maxLength: 14 });
  const at = (...l: number[]) => l.map((x) => LEVELS.indexOf(x as (typeof LEVELS)[number]));
  const KEPT = [5, 10, 25, 50, 75, 90, 95];

  it('every row is one point at its own day; the seven kept columns are the published values, `---` null and flagged', () => {
    fc.assert(
      fc.property(rows, (cells) => {
        const out = normalise(table(text(cells)), { variant: EMMERICH, keyOf });
        const pts = out.forecasts?.[0]?.points ?? [];
        expect(pts).toHaveLength(cells.length);
        expect(out.dropped).toEqual({});
        for (const [i, p] of pts.entries()) {
          expect(p.ts).toBe(new Date(FIRST + i * DAY - HOUR).toISOString());
          const kept = at(...KEPT).map((c) => (cells[i] as Cells)[c] as number | null);
          expect([p.p05, p.p10, p.p25, p.p50, p.p75, p.p90, p.p95]).toEqual(kept);
          expect(p.value).toBe(kept[3]);
          expect(p.flags).toBe(kept.some((v) => v === null) ? CENSORED : 0);
          // Never a 0 for a `---`.
          for (const [j, v] of kept.entries())
            if (v === null) expect([p.p05, p.p10, p.p25, p.p50, p.p75, p.p90, p.p95][j]).toBeNull();
          expect(p).not.toHaveProperty('p30');
          expect(p).not.toHaveProperty('p70');
        }
      }),
    );
  });

  it('the loader’s check keeps every row (a censored one too) in time order, and ORDER means exactly crossed present values', () => {
    fc.assert(
      fc.property(rows, (cells) => {
        const out = normalise(table(text(cells)), { variant: EMMERICH, keyOf });
        const c = checked(out);
        expect(c.dropped).toEqual({});
        const pts = c.run?.points ?? [];
        expect(pts).toHaveLength(cells.length);
        expect(pts.map((p) => p.ms)).toEqual(cells.map((_, i) => FIRST + i * DAY - HOUR));
        for (const [i, p] of pts.entries()) {
          const k = at(...KEPT).map((c) => (cells[i] as Cells)[c] as number | null);
          const present = k.filter((v): v is number => v !== null);
          const crossed = present.some((v, j) => j > 0 && v < (present[j - 1] as number));
          expect((p.flags & ORDER) !== 0).toBe(crossed);
          // The stored values are the published ones in their columns (value p05 p10 p25 p30 p50 p70 p75 p90 p95 vmin
          // vmax), never sorted.
          expect(p.v).toEqual([k[3], k[0], k[1], k[2], null, k[3], null, k[4], k[5], k[6], null, null]);
        }
      }),
    );
  });

  it('the parser answers any bytes with a table or a SchemaDrift, never another error', () => {
    const base = Buffer.from(text(ramp(3)), 'latin1');
    const mutated = fc
      .array(fc.tuple(fc.nat(base.length), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 4 })
      .map((edits) => {
        const b = Buffer.from(base);
        for (const [i, v] of edits) if (i < b.length) b[i] = v;
        return new Uint8Array(b);
      });
    const truncated = fc.nat(base.length).map((n) => new Uint8Array(base.subarray(0, n)));
    fc.assert(
      fc.property(fc.oneof(fc.uint8Array({ maxLength: 400 }), mutated, truncated), (b) => {
        try {
          const t = parseTable(b);
          expect(t.rows.length).toBeLessThanOrEqual(MAX_ROWS);
          for (const r of t.rows) expect(r.cells).toHaveLength(LEVELS.length);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 400 },
    );
  });
});
