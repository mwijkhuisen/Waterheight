import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Normalised, ObsRow, QC, type Registry, SchemaDrift, type SeriesDecl } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { label, normalise as normaliseLu1 } from '../../src/adapters/lu-1/normalise.ts';
import { parseCsv } from '../../src/adapters/lu-1/parse.ts';
import { type Context, normalise } from '../../src/adapters/lu-2/normalise.ts';
import { JSON_CAPS, parseJson } from '../../src/adapters/lu-2/parse.ts';
import { judgeTwin } from '../../src/load/twins.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// LU-2 AGE per-station JSON (owner audience, catalogue §2.6): parse + normalise of the hand-made synthetic
// fixtures equal the committed goldens (invariant 9: the repository holds no real owner value), the DST proof
// of the fall-back night (the stamps carry their own offsets), the rules, and the LU-2 = LU-1 relation that the
// twin check of P5c depends on. `UPDATE_GOLDEN=1` rewrites the goldens.

const parseFile = (body: Uint8Array) => parseJson(body)[0];
const DIEKIRCH = '0/11/W_out/15m.Cmd.RelAbs.P';
const LAC = '0/2/W_out_LAC/15m.Cmd.Abs.P';
const decl = (key: string, unit: string, factor: number, kind: 'stage' | 'level'): SeriesDecl => ({
  key,
  quantity: 'H',
  native_unit: unit,
  to_canonical: factor,
  value_kind: kind,
  native_step_ms: 900_000,
  expected_step_ms: 900_000,
});
// The registry is built here: registry/stations/lu-2.yaml comes later. 'Diekirch' is the LU-1 key of the same gauge.
const registry: Registry = new Map([
  [DIEKIRCH, decl(DIEKIRCH, 'cm', 1, 'stage')],
  [LAC, decl(LAC, 'm', 100, 'level')],
  ['Diekirch', decl('Diekirch', 'cm', 1, 'stage')],
]);

/** The fixtures carry no recorded_at (hand-made): the fetch time of each is stated here. */
const FETCHED: Record<string, string> = {
  'lu-2-json-cm.synthetic': '2026-10-21T06:00:00Z',
  'lu-2-json-lac-m.synthetic': '2026-10-20T10:00:00Z',
  'lu-2-json-dst-fall-back.synthetic': '2026-10-25T03:00:00Z',
  'lu-2-json-empty.synthetic': '2026-10-21T00:00:00Z',
  'lu-2-json-unit-mismatch.synthetic': '2026-10-20T06:00:00Z',
};

function golden(name: string, actual: Normalised): Normalised {
  const url = goldenUrl('LU-2', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const run = (name: string) =>
  normalise(parseFile(rawFixture('LU-2', name).body), { registry, fetchedAt: Date.parse(FETCHED[name] as string) });
const ts = (out: Normalised) => out.obs.map((r) => r.ts);
const steps = (out: Normalised) =>
  out.obs.slice(1).map((r, i) => Date.parse(r.ts) - Date.parse(out.obs[i]?.ts as string));
const AT = Date.parse('2026-10-20T12:00:00Z');
const stamp = (ms: number) =>
  Temporal.Instant.fromEpochMilliseconds(ms).toString({ timeZone: 'Europe/Luxembourg', smallestUnit: 'millisecond' });
type Over = Partial<{ ts_path: string; ts_unitsymbol: string; columns: string }>;
const json = (data: unknown[], over: Over = {}) =>
  Buffer.from(
    JSON.stringify([
      {
        ts_path: DIEKIRCH,
        ts_unitsymbol: 'cm',
        station_name: 'Diekirch',
        parametertype_name: 'W',
        rows: String(data.length),
        columns: 'Timestamp,Value',
        data,
        ...over,
      },
    ]),
  );
const go = (data: unknown[], over: Over = {}, extra: Partial<Context> = {}) =>
  normalise(parseFile(json(data, over)), { registry, fetchedAt: AT, ...extra });

describe('golden files (synthetic: the source is owner audience)', () => {
  it('a cm stage file: 100 rows of 15 minutes, two 30-minute holes stay holes', () => {
    const out = run('lu-2-json-cm.synthetic');
    expect(out).toEqual(golden('lu-2-json-cm.synthetic', out));
    expect(out.obs).toHaveLength(100);
    expect(out.dropped).toEqual({});
    // The two omitted stamps (05:45Z and 13:30Z on 2026-10-20) are neither filled nor zero.
    expect(ts(out)).not.toContain('2026-10-20T05:45:00.000Z');
    expect(ts(out)).not.toContain('2026-10-20T13:30:00.000Z');
    const holes = steps(out).flatMap((s, i) => (s === 1_800_000 ? [[out.obs[i]?.ts, out.obs[i + 1]?.ts]] : []));
    expect(holes).toEqual([
      ['2026-10-20T05:30:00.000Z', '2026-10-20T06:00:00.000Z'],
      ['2026-10-20T13:15:00.000Z', '2026-10-20T13:45:00.000Z'],
    ]);
    expect(steps(out).every((s) => s === 900_000 || s === 1_800_000)).toBe(true);
    // 2026-10-20T00:15+02:00 is 22:15Z of the day before; the value is as published (cm).
    expect(out.obs[0]).toEqual({ series: DIEKIRCH, ts: '2026-10-19T22:15:00.000Z', value: 121, qc: QC.RAW });
  });

  it('an Esch-Sûre-like dam file: m NN ×100 → cm, a level', () => {
    const out = run('lu-2-json-lac-m.synthetic');
    expect(out).toEqual(golden('lu-2-json-lac-m.synthetic', out));
    expect(out.obs).toHaveLength(48);
    expect(out.obs[0]).toEqual({ series: LAC, ts: '2026-10-19T22:00:00.000Z', value: 31420, qc: QC.RAW });
    expect(out.obs.every((r) => r.value > 31_400 && r.value < 31_440 && r.qc === QC.RAW)).toBe(true);
  });

  it('the fall-back night 2026-10-25: 02:00–02:45 twice, each stamp with its own offset, strictly increasing UTC', () => {
    const name = 'lu-2-json-dst-fall-back.synthetic';
    const out = run(name);
    expect(out).toEqual(golden(name, out));
    expect(parseFile(rawFixture('LU-2', name).body).data.map(([t]) => t)).toEqual([
      '2026-10-25T01:45:00.000+02:00',
      '2026-10-25T02:00:00.000+02:00',
      '2026-10-25T02:15:00.000+02:00',
      '2026-10-25T02:30:00.000+02:00',
      '2026-10-25T02:45:00.000+02:00',
      '2026-10-25T02:00:00.000+01:00',
      '2026-10-25T02:15:00.000+01:00',
      '2026-10-25T02:30:00.000+01:00',
      '2026-10-25T02:45:00.000+01:00',
      '2026-10-25T03:00:00.000+01:00',
      '2026-10-25T03:15:00.000+01:00',
    ]);
    // 01:45+02:00 is 23:45Z; then every quarter hour of 00:00Z … 02:15Z, no instant twice, none missing.
    expect(ts(out)).toEqual([
      '2026-10-24T23:45:00.000Z',
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T00:15:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T00:45:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T01:15:00.000Z',
      '2026-10-25T01:30:00.000Z',
      '2026-10-25T01:45:00.000Z',
      '2026-10-25T02:00:00.000Z',
      '2026-10-25T02:15:00.000Z',
    ]);
    expect(new Set(ts(out)).size).toBe(11);
    expect(steps(out)).toEqual(Array(10).fill(900_000));
    expect(out.obs.map((r) => r.value)).toEqual(Array.from({ length: 11 }, (_, i) => 200 + i));
    expect(out.dropped).toEqual({});
  });

  it('a file without data rows: no rows, no drift', () => {
    const out = run('lu-2-json-empty.synthetic');
    expect(out).toEqual(golden('lu-2-json-empty.synthetic', out));
    expect(out).toMatchObject({ obs: [], dropped: {}, unknown: 0 });
  });

  it('a unit that is not the series native unit withholds every value and names the series', () => {
    const out = run('lu-2-json-unit-mismatch.synthetic');
    expect(out).toEqual(golden('lu-2-json-unit-mismatch.synthetic', out));
    expect(out).toMatchObject({ obs: [], dropped: { unit_mismatch: 8 } });
    // Not listed: the loader keeps one list per source, and each LU-2 file states one series.
    expect(out.unitMismatch).toBeUndefined();
  });

  it('the P1 capture fixture (structure only: generated names, units and column labels) is not a payload', () => {
    // Its `columns` is not "Timestamp,Value": the strict parse refuses it, as it would any other column list.
    expect(() => parseFile(rawFixture('LU-2', 'lu-2-json.synthetic').body)).toThrow(SchemaDrift);
  });
});

describe('rules (synthetic)', () => {
  const NIGHT = { fetchedAt: Date.parse('2026-10-25T03:00:00Z') };
  it('a hole in the stamps stays a hole: no row is invented', () => {
    const out = go([
      ['2026-10-20T10:00:00.000+02:00', 1],
      ['2026-10-20T10:15:00.000+02:00', 2],
      ['2026-10-20T11:00:00.000+02:00', 3],
    ]);
    expect(ts(out)).toEqual(['2026-10-20T08:00:00.000Z', '2026-10-20T08:15:00.000Z', '2026-10-20T09:00:00.000Z']);
  });

  it('a null value is a gap, never 0', () => {
    const out = go([
      ['2026-10-20T10:00:00.000+02:00', 1],
      ['2026-10-20T10:15:00.000+02:00', null],
      ['2026-10-20T10:30:00.000+02:00', 3],
    ]);
    expect(out.obs.map((r) => r.value)).toEqual([1, 3]);
    expect(out.dropped).toEqual({ gap: 1 });
  });

  it('Esch-Sûre m → cm (a level, ×100); another unit withholds it; a stage outside the range keeps its range bit', () => {
    const lac = go([['2026-10-20T10:00:00.000+02:00', 314.35]], { ts_path: LAC, ts_unitsymbol: 'm' });
    expect(lac.obs).toEqual([{ series: LAC, ts: '2026-10-20T08:00:00.000Z', value: 31435, qc: QC.RAW }]);
    const cm = go([['2026-10-20T10:00:00.000+02:00', 31435]], { ts_path: LAC, ts_unitsymbol: 'cm' });
    expect(cm).toMatchObject({ obs: [], dropped: { unit_mismatch: 1 } });
    // A stage over 5,000 cm is implausible: kept, marked (our range bit), never silently dropped.
    expect(go([['2026-10-20T10:00:00.000+02:00', 6000]]).obs[0]?.qc).toBe(QC.RAW | QC.RANGE);
  });

  it('a path the registry does not know is unknown and stores nothing; the path is matched exactly', () => {
    for (const ts_path of ['0/11/W_out/15m.Cmd.RelAbs.p', ` ${DIEKIRCH}`, 'Diekirch-x']) {
      const out = go([['2026-10-20T10:00:00.000+02:00', 1]], { ts_path });
      expect(out).toMatchObject({ obs: [], unknown: 1, dropped: {} });
      expect(out.unitMismatch).toBeUndefined();
    }
  });

  it('a stamp more than 15 minutes ahead of the fetch, or older than 45 days, is dropped', () => {
    const out = go(
      [
        ['2026-10-20T12:15:00.000Z', 1],
        ['2026-10-20T12:16:00.000Z', 2],
        ['2026-09-05T11:59:00.000Z', 3],
        ['2026-09-05T12:00:00.000Z', 4],
      ],
      {},
      { fetchedAt: Date.parse('2026-10-20T12:00:00Z') },
    );
    // Exactly 45 days back is kept; time order, not file order.
    expect(out.obs.map((r) => r.value)).toEqual([4, 1]);
    expect(out.dropped).toEqual({ future: 1, too_old: 1 });
  });

  it('one instant twice: the same value is kept once; two values are both withheld (conflict), a third stamp too', () => {
    // 02:00+02:00 and 00:00Z are one instant.
    const same = go(
      [
        ['2026-10-25T02:00:00.000+02:00', 5],
        ['2026-10-25T00:00:00.000Z', 5],
      ],
      {},
      NIGHT,
    );
    expect(same.obs.map((r) => [r.ts, r.value])).toEqual([['2026-10-25T00:00:00.000Z', 5]]);
    expect(same.dropped).toEqual({ duplicate: 1 });
    const clash = go(
      [
        ['2026-10-25T02:00:00.000+02:00', 5],
        ['2026-10-25T00:00:00.000Z', 6],
        ['2026-10-25T00:15:00.000Z', 7],
      ],
      {},
      NIGHT,
    );
    expect(clash.obs.map((r) => r.ts)).toEqual(['2026-10-25T00:15:00.000Z']);
    expect(clash.dropped).toEqual({ conflict: 2 });
    const three = go(
      [
        ['2026-10-25T02:00:00.000+02:00', 5],
        ['2026-10-25T00:00:00.000Z', 6],
        ['2026-10-25T00:00:00.000Z', 5],
      ],
      {},
      NIGHT,
    );
    expect(three).toMatchObject({ obs: [], dropped: { conflict: 3 } });
  });

  it('rows come out in time order, whatever the file order is', () => {
    const out = go([
      ['2026-10-20T10:30:00.000+02:00', 3],
      ['2026-10-20T10:00:00.000+02:00', 1],
      ['2026-10-20T10:15:00.000+02:00', 2],
    ]);
    expect(out.obs.map((r) => r.value)).toEqual([1, 2, 3]);
  });

  it.each([
    ['a stamp without an offset', '2026-10-20T10:00:00.000', 'time_bad_format'],
    ['a stamp that is no date', '2026-13-40T10:00:00.000+02:00', 'time_bad_format'],
    ['a stamp in another form', '20.10.2026 10:00', 'time_bad_format'],
    ['a stamp far outside the range', '0100-01-01T00:00:00.000Z', 'time_out_of_range'],
  ])('refuses %s as drift (quarantined, never read under a guessed zone)', (_, stampText, code) => {
    expect(() => go([[stampText, 1]])).toThrow(SchemaDrift);
    try {
      go([[stampText, 1]]);
    } catch (err) {
      expect((err as SchemaDrift).code).toBe(code);
    }
  });

  const row = ['2026-10-20T10:00:00.000+02:00', 1];
  it.each<[string, Buffer, string]>([
    ['bytes that are no UTF-8', Buffer.from([0x5b, 0xff]), 'encoding'],
    ['text that is no JSON', Buffer.from('[{'), 'not_json'],
    ['an object instead of an array', Buffer.from('{}'), 'invalid_type'],
    ['an empty array', Buffer.from('[]'), 'array_length'],
    [
      'two stations in one file',
      Buffer.from(`[${json([row]).toString().slice(1, -1)},${json([row]).toString().slice(1, -1)}]`),
      'array_length',
    ],
    ['another column list (values are read by position)', json([row], { columns: 'Value,Timestamp' }), 'invalid_value'],
    ['an unknown key', Buffer.from(json([row]).toString().replace('"rows"', '"extra":1,"rows"')), 'unrecognized_keys'],
    [
      'a row count that is no digit string',
      Buffer.from(json([row]).toString().replace('"rows":"1"', '"rows":"1x"')),
      'invalid_format',
    ],
    [
      'a row count that is a number',
      Buffer.from(json([row]).toString().replace('"rows":"1"', '"rows":1')),
      'invalid_type',
    ],
    ['an over-long path', json([row], { ts_path: 'x'.repeat(201) }), 'too_big'],
    ['a row with a third element', json([[...row, 1]]), 'too_big'],
    ['a value that is a string', json([['2026-10-20T10:00:00.000+02:00', '1.0']]), 'invalid_type'],
    ['a stamp that is a number', json([[1, 1]]), 'invalid_type'],
    ['more than 3,500 rows', json(Array.from({ length: 3501 }, () => row)), 'too_big'],
    ['a document nested over the depth cap', Buffer.from('[[[[[[[]]]]]]]'), 'json_too_deep'],
    ['a document over the node cap', Buffer.from(`[${'1,'.repeat(JSON_CAPS.maxNodes)}1]`), 'json_too_many_nodes'],
  ])('refuses %s', (_, body, code) => {
    expect(() => parseFile(body)).toThrow(SchemaDrift);
    try {
      parseFile(body);
    } catch (err) {
      expect((err as SchemaDrift).code).toBe(code);
    }
  });

  it('a full real-size file (3,500 rows, the cap) parses', () => {
    const data = Array.from({ length: 3500 }, (_, i) => [stamp(Date.parse('2026-10-01T00:00:00Z') + i * 900_000), i]);
    expect(parseFile(json(data)).data).toHaveLength(3500);
  });
});

describe('LU-2 is a twin of LU-1: equal after the detected label offset', () => {
  // The same gauge, the same 15-minute series: LU-1 (a CSV whose labels are 15 minutes late, the old 5-day format)
  // and LU-2 (stamps on true time). The loader applies LU-1's measured offset (load/label-offset.ts), after
  // which the two coincide point for point; LU-2 itself never needs one.
  const t0 = Date.parse('2026-10-20T06:00:00Z');
  const instants = Array.from({ length: 96 }, (_, k) => t0 + k * 900_000);
  const value = (k: number) => Number((100 + 0.5 * k + ((k * 7) % 5) * 0.1).toFixed(1));
  const fetchedAt = Date.parse('2026-10-21T08:00:00Z');
  const quote = (s: string) => `"${s}"`;
  const csv = (labels: string[], cells: number[]) =>
    Buffer.from(
      `${['Name', 'Number', 'Unit', ...labels].map(quote).join(',')}\n${['Diekirch', '', 'cm', ...cells.map(String)].map(quote).join(',')},""\n`,
    );
  const lu2 = normalise(parseFile(json(instants.map((t, k) => [stamp(t), value(k)]))), { registry, fetchedAt });
  // The label 15 minutes after the instant the value belongs to.
  const lu1Body = csv(
    instants.map((t) => label(t + 900_000)),
    instants.map((_, k) => value(k)),
  );
  const lu1 = (days: Record<string, number> = {}) =>
    normaliseLu1(parseCsv(lu1Body), { registry, fetchedAt, labelOffsets: { days } });
  const points = (out: Normalised) => out.obs.map((r) => ({ ts: Date.parse(r.ts), value: r.value }));
  const relation = { kind: 'offset', expected: 0, tolerance: 0.05, min_share: 0.98 } as const;

  it('with the detected offset the two lists are one list and the twin check is ok at lag 0', () => {
    const a = points(lu2);
    const b = points(lu1({ '2026-10-20': 15 }));
    expect(b).toEqual(a);
    expect(judgeTwin(a, b, relation)).toEqual({
      n_aligned: 96,
      median_delta: 0,
      max_delta: 0,
      lag_min: 0,
      ok: true,
    });
  });

  it('without the offset the labels are 15 minutes late: not ok, lag 15 (LU-1 sits 15 minutes after LU-2)', () => {
    const result = judgeTwin(points(lu2), points(lu1()), relation);
    expect(result).toMatchObject({ lag_min: 15, ok: false });
    // LU-1's labels are 15 minutes late: its 96 points hold the same values 15 minutes after LU-2's.
    expect(result.n_aligned).toBe(95);
  });
});

describe('the archive-derived fixtures (fixtures:synth: real structure, generated values)', () => {
  // Real structure and the identifiers the registry publishes; every other value is generated and every timestamp is
  // shifted years ahead (one constant per document), so the fetch time is the payload's newest instant + 10 minutes.
  const real = registryOf('LU-2');
  const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
  const newest = (body: Buffer) =>
    Math.max(...(body.toString('utf8').match(STAMP) ?? []).map((s) => Date.parse(s))) + 600_000;
  const files = [
    ['lu-2-json-diekirch.synthetic', '0/11/W_out/15m.Cmd.RelAbs.P'],
    ['lu-2-json-diekirch-first.synthetic', '0/11/W_out/15m.Cmd.RelAbs.P'],
    ['lu-2-json-esch-sure.synthetic', '0/40/W_out_LAC/15m.Cmd.RelAbs.P'],
  ] as const;

  for (const [name, path] of files) {
    it(`${name}: rows of the registered series ${path}`, () => {
      const { body } = rawFixture('LU-2', name);
      const file = parseFile(body);
      expect(file.ts_path).toBe(path);
      const out = normalise(file, { registry: real, fetchedAt: newest(body) });
      expect(out).toEqual(golden(name, out));
      const decl = real.get(path) as SeriesDecl;
      expect(file.ts_unitsymbol).toBe(decl.native_unit);
      expect(out.unknown).toBe(0);
      expect(out.unitMismatch).toBeUndefined();
      expect(out.obs.length).toBeGreaterThan(0);
      expect(out.obs.length + Object.values(out.dropped).reduce((a, b) => a + b, 0)).toBe(file.data.length);
      for (const r of out.obs) {
        ObsRow.parse(r);
        expect(r.series).toBe(path);
        expect(r.qc & QC.RAW).toBe(QC.RAW);
      }
      const order = ts(out);
      expect(order).toEqual([...order].sort());
      expect(new Set(order).size).toBe(order.length);
      // Values as published: the registry factor only (Esch-Sûre is a dam level in m NN, ×100 to cm; Diekirch is cm).
      const published = new Map(file.data.map(([stamp, v]) => [Date.parse(stamp), v]));
      for (const r of out.obs)
        expect(r.value).toBeCloseTo((published.get(Date.parse(r.ts)) as number) * decl.to_canonical, 6);
    });
  }

  it('Esch-Sûre is a level (×100, m → cm) and Diekirch a cm stage', () => {
    expect(real.get('0/40/W_out_LAC/15m.Cmd.RelAbs.P')).toMatchObject({
      native_unit: 'm',
      to_canonical: 100,
      value_kind: 'level',
    });
    expect(real.get('0/11/W_out/15m.Cmd.RelAbs.P')).toMatchObject({
      native_unit: 'cm',
      to_canonical: 1,
      value_kind: 'stage',
    });
  });
});

describe('property and fuzz tests', () => {
  it('normalise yields valid, unique, increasing rows from generated files, also across both DST nights', () => {
    const start = fc.oneof(
      fc.integer({ min: 0, max: 40 }).map((i) => Date.parse('2026-10-24T20:00:00Z') + i * 15 * 60_000),
      fc.integer({ min: 0, max: 40 }).map((i) => Date.parse('2027-03-27T20:00:00Z') + i * 15 * 60_000),
    );
    // A step is a value (tenths of a cm), a null, or a hole (no stamp at all).
    const cell = fc.oneof(fc.integer({ min: -500, max: 2000 }), fc.constant(null), fc.constant(undefined));
    fc.assert(
      fc.property(start, fc.array(cell, { minLength: 1, maxLength: 60 }), (t0, cells) => {
        const data = cells.flatMap((c, i) =>
          c === undefined ? [] : [[stamp(t0 + i * 900_000), c === null ? null : c / 10]],
        );
        const out = normalise(parseFile(json(data)), { registry, fetchedAt: t0 + 61 * 900_000 });
        const times = out.obs.map((r) => Date.parse(r.ts));
        for (const r of out.obs) ObsRow.parse(r);
        expect(times).toEqual([...times].sort((x, y) => x - y));
        expect(new Set(times).size).toBe(times.length);
        // A row for every stamped value, none for a null or a hole, at its own instant.
        const expected = cells.flatMap((c, i) => (c === null || c === undefined ? [] : [[t0 + i * 900_000, c / 10]]));
        expect(out.obs.map((r) => [Date.parse(r.ts), r.value])).toEqual(expected);
        expect(out.dropped.gap ?? 0).toBe(cells.filter((c) => c === null).length);
      }),
      { numRuns: 300 },
    );
  });

  it('parse and normalise never throw anything but SchemaDrift on arbitrary or JSON-shaped input', () => {
    const anyStamp = fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.constantFrom(
        '2026-10-25T02:00:00.000+02:00',
        '2026-10-25T02:00:00.000+01:00',
        '2026-10-25T00:00:00Z',
        '2026-10-25',
      ),
    );
    const anyValue = fc.oneof(fc.double({ noNaN: true }), fc.constant(null), fc.constantFrom('1.0', 1e300, -1e300));
    const shaped = fc
      .record({
        ts_path: fc.constantFrom(DIEKIRCH, LAC, 'x'),
        ts_unitsymbol: fc.constantFrom('cm', 'm', 'mm'),
        columns: fc.constantFrom('Timestamp,Value', 'Value'),
        data: fc.array(fc.tuple(anyStamp, anyValue), { maxLength: 8 }),
      })
      .map(({ data, ...over }) => json(data, over));
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array().map((u) => Buffer.from(u)),
          fc.string().map((s) => Buffer.from(s)),
          shaped,
        ),
        (b) => {
          try {
            normalise(parseFile(b), { registry, fetchedAt: Date.parse('2026-10-25T03:00:00Z') });
          } catch (err) {
            expect(err).toBeInstanceOf(SchemaDrift);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
