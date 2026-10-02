import { SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  columnsOf,
  KIWIS_CAPS,
  parseLayer,
  parseTable,
  parseValues,
  tableRecords,
} from '../../src/adapters/_shared/kiwis/parse.ts';
import {
  kiwisUrlProblems,
  MAX_CALLS,
  MAX_IDS,
  MAX_VALUES,
  MIN_STEP_MS,
  spanMs,
  valuesRequests,
} from '../../src/adapters/_shared/kiwis/request.ts';
import { adapter, PARAMETERS } from '../../src/adapters/be-3/capture.ts';
import type { Req } from '../../src/http/types.ts';

// The shared KiWIS client (catalogue §2.4; SPW now, HIC and VMM from P13): the request builder keeps every call
// within the provider's limits (100 ts_ids, 250,000 values, UTC, explicit Z), the URL check names what we must never
// ask, the three strict parsers treat an error object as drift, and BE-3's catch-up `expand` plans only digit ts_ids
// of the six stored parameters inside the seed's window.

const BASE =
  'https://hydrometrie.wallonie.be/services/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=0&format=json&request=getTimeseriesList&timeseriesgroup_id=1962373';
const WINDOW = { from: new Date('2026-08-24T00:00:00Z'), to: new Date('2026-08-27T00:00:00Z') };
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
const variant = (from: Date, batch: number) => `${batch}|${from.toISOString()}`;
const idsOf = (n: number) => Array.from({ length: n }, (_, i) => String(240_000_010 + i * 10));
const drift = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaDrift);
    expect((err as SchemaDrift).code).toBe(code);
    return;
  }
  throw new Error(`no SchemaDrift ${code}`);
};

describe('valuesRequests (the KiWIS request builder)', () => {
  it('every call has at most 100 ts_ids and 250,000 values, asks in UTC with explicit Z bounds, and the windows leave no hole', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        // Whole seconds, because a URL states seconds: from one second to 400 days.
        fc.integer({ min: 1, max: 400 * 86_400 }),
        fc.integer({ min: 0, max: 30 * 86_400 }),
        (n, spanS, offsetS) => {
          const from = new Date(Date.UTC(2026, 7, 24) + offsetS * 1000);
          const to = new Date(from.getTime() + spanS * 1000);
          const ids = idsOf(n);
          const reqs = valuesRequests(BASE, ids, { from, to }, { variant });
          const batches = new Map<number, { from: number; to: number; ids: string[] }[]>();
          // Plain checks, one assertion at the end: a window of 400 days and 1,000 series is 4,000 calls.
          const problems: string[] = [];
          const check = (ok: boolean, what: string) => {
            if (!ok) problems.push(what);
          };
          for (const r of reqs) {
            const q = new URL(r.url).searchParams;
            const asked = (q.get('ts_id') ?? '').split(',');
            const f = Date.parse(q.get('from') ?? '');
            const t = Date.parse(q.get('to') ?? '');
            check(asked.length <= MAX_IDS, 'ids');
            // The theoretical values, recomputed from the URL alone: series × (minutes + 1), at one-minute steps.
            check(asked.length * (Math.ceil((t - f) / MIN_STEP_MS) + 1) === r.values, 'values');
            check(r.values <= MAX_VALUES, 'limit');
            check(q.get('timezone') === 'UTC', 'timezone');
            check(/Z$/.test(q.get('from') ?? '') && /Z$/.test(q.get('to') ?? ''), 'Z');
            check(q.get('request') === 'getTimeseriesValues' && q.get('datasource') === '0', 'request');
            check(kiwisUrlProblems(r.url).length === 0, 'url');
            check(r.method === 'GET' && r.timeout === 'normal' && r.seen_id === r.variant, 'shape');
            const batch = Number(r.variant.split('|')[0]);
            batches.set(batch, [...(batches.get(batch) ?? []), { from: f, to: t, ids: asked }]);
          }
          expect(problems).toEqual([]);
          // Each batch covers the whole window in order, window after window, for the same ids.
          for (const windows of batches.values()) {
            expect(windows[0]?.from).toBe(from.getTime());
            expect(windows.at(-1)?.to).toBe(to.getTime());
            expect(windows.every((w, i) => w.from < w.to && (i === 0 || w.from === windows[i - 1]?.to))).toBe(true);
            expect(windows.every((w) => w.ids.join() === windows[0]?.ids.join())).toBe(true);
          }
          // Every series is in exactly one batch, in the order given.
          expect([...batches.keys()]).toEqual(Array.from({ length: Math.ceil(n / MAX_IDS) }, (_, i) => i));
          expect([...batches.values()].flatMap((w) => w[0]?.ids ?? [])).toEqual(ids);
        },
      ),
      { numRuns: 100 },
    );
  }, 30_000);

  it('a window is whole days while a day fits: 100 series one day, one series 173 days, 1,000 series 249 minutes', () => {
    expect(spanMs(100)).toBe(86_400_000);
    expect(spanMs(1) / 86_400_000).toBe(173);
    expect(spanMs(1000) / 60_000).toBe(249);
    expect(() => spanMs(125_001)).toThrow(RangeError);
    // The longest call of a full batch of 100 series asks 144,100 values.
    const [r] = valuesRequests(
      BASE,
      idsOf(100),
      { from: WINDOW.from, to: new Date(WINDOW.from.getTime() + 86_400_000) },
      { variant },
    );
    expect(r?.values).toBe(100 * 1441);
  });

  it('a call in the order given: batches of 100, three days make three windows of one day for 100 series', () => {
    const reqs = valuesRequests(BASE, idsOf(150), WINDOW, { variant });
    expect(reqs.map((r) => r.variant.split('|')[0])).toEqual(['0', '0', '0', '1']);
    expect(reqs.map((r) => r.variant.split('|')[1])).toEqual([
      '2026-08-24T00:00:00.000Z',
      '2026-08-25T00:00:00.000Z',
      '2026-08-26T00:00:00.000Z',
      '2026-08-24T00:00:00.000Z',
    ]);
    // 50 series fit 2,000+ minutes; the last window is cut at the window's end.
    expect(new URL(reqs[3]?.url ?? '').searchParams.get('to')).toBe('2026-08-27T00:00:00Z');
  });

  it('an empty or reversed window, and no series, are no requests; the caller headers ride along', () => {
    expect(valuesRequests(BASE, idsOf(3), { from: WINDOW.to, to: WINDOW.from }, { variant })).toEqual([]);
    expect(valuesRequests(BASE, idsOf(3), { from: WINDOW.from, to: WINDOW.from }, { variant })).toEqual([]);
    expect(valuesRequests(BASE, [], WINDOW, { variant })).toEqual([]);
    const [r] = valuesRequests(BASE, idsOf(1), WINDOW, { variant, headers: { authorization: 'Bearer x' } });
    expect(r?.headers).toEqual({ authorization: 'Bearer x' });
    expect(valuesRequests(BASE, idsOf(1), WINDOW, { variant })[0]).not.toHaveProperty('headers');
    // The caller can only tighten the limits, never loosen them.
    const tight = valuesRequests(BASE, idsOf(10), WINDOW, {
      variant,
      maxIds: 5,
      maxValues: 1_000_000,
      minStepMs: 3_600_000,
    });
    expect(tight.every((x) => (new URL(x.url).searchParams.get('ts_id') ?? '').split(',').length <= 5)).toBe(true);
    expect(tight.every((x) => x.values <= MAX_VALUES)).toBe(true);
  });

  it('a limit of 0, a negative or a fractional one is refused (it would never end the plan)', () => {
    for (const bad of [0, -1, -100, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const key of ['maxIds', 'maxValues', 'minStepMs']) {
        expect(() => valuesRequests(BASE, idsOf(3), WINDOW, { variant, [key]: bad })).toThrow(RangeError);
      }
    }
    // The smallest legal limits still make a plan (one series and two values, one minute, a call), and a 1 ms step
    // is a plan of 518 million calls: refused, never built.
    expect(valuesRequests(BASE, idsOf(2), WINDOW, { variant, maxIds: 1, maxValues: 2 })).toHaveLength(2 * 3 * 1440);
    expect(() => valuesRequests(BASE, idsOf(2), WINDOW, { variant, maxIds: 1, maxValues: 2, minStepMs: 1 })).toThrow(
      RangeError,
    );
  });

  it('a plan of more than MAX_CALLS calls is refused before it is built', () => {
    // A batch of 100 series asks one day a call: 100 series over MAX_CALLS days is the largest plan.
    const days = (n: number) => ({ from: WINDOW.from, to: new Date(WINDOW.from.getTime() + n * 86_400_000) });
    expect(valuesRequests(BASE, idsOf(100), days(MAX_CALLS), { variant })).toHaveLength(MAX_CALLS);
    expect(() => valuesRequests(BASE, idsOf(100), days(MAX_CALLS + 1), { variant })).toThrow(RangeError);
    expect(() => valuesRequests(BASE, idsOf(2000), days(501), { variant })).toThrow(RangeError);
  });

  it('a ts_id that is not digits is refused, even for an empty window', () => {
    for (const bad of ['12a', '1,2', '-1', '', '1.5', '1234567890123', '12\n', ' 12', '１２', '1;2', '1&from=x']) {
      expect(() => valuesRequests(BASE, [bad], WINDOW, { variant })).toThrow(RangeError);
      expect(() => valuesRequests(BASE, ['1', bad], { from: WINDOW.to, to: WINDOW.from }, { variant })).toThrow(
        RangeError,
      );
    }
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^\d{1,12}$/.test(s)),
        (s) => {
          expect(() => valuesRequests(BASE, [s], WINDOW, { variant })).toThrow(RangeError);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a base URL without a numeric datasource is refused; the series list and window come from nothing else', () => {
    const noSource = 'https://hydrometrie.wallonie.be/services/KiWIS/KiWIS?service=kisters&type=queryServices';
    expect(() => valuesRequests(noSource, ['1'], WINDOW, { variant })).toThrow(RangeError);
    for (const ds of ['abc', '1234', '', '-1', '1.5'])
      expect(() => valuesRequests(`${noSource}&datasource=${ds}`, ['1'], WINDOW, { variant })).toThrow(RangeError);
    expect(() => valuesRequests('not a url', ['1'], WINDOW, { variant })).toThrow();
    // Only the origin, the path and the datasource of the base reach the call: nothing else of its query does.
    const [r] = valuesRequests(`${BASE}&ts_path=*&token=secret`, ['5'], WINDOW, { variant });
    expect(r?.url).toContain('https://hydrometrie.wallonie.be/services/KiWIS/KiWIS?');
    expect([...new URL(r?.url ?? '').searchParams.keys()]).not.toEqual(expect.arrayContaining(['token']));
    expect(new URL(r?.url ?? '').searchParams.has('ts_path')).toBe(false);
    expect(r?.url).not.toMatch(/secret|%2A|\*/);
  });
});

describe('kiwisUrlProblems (what a KiWIS URL of ours must never do)', () => {
  const good = valuesRequests(BASE, ['1', '2'], WINDOW, { variant })[0]?.url ?? '';
  const stations =
    'https://hydrometrie.wallonie.be/services/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=0&format=json&request=getStationList&returnfields=station_no,river_name,ca_sta';
  const list = (fields: string) =>
    `https://hydrometrie.wallonie.be/services/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=0&format=json&request=getTimeseriesList&timeseriesgroup_id=1&returnfields=${fields}`;

  it('a malformed percent-escape is a problem, never an exception', () => {
    expect(kiwisUrlProblems(`${good}&x=%E0%A4%A`)).toContain('encoding');
  });

  it('a built call and the metadata calls of the registry pass', () => {
    expect(kiwisUrlProblems(good)).toEqual([]);
    expect(kiwisUrlProblems(stations)).toEqual([]); // river_name is valid for stations
    expect(kiwisUrlProblems(list('station_no,ts_id,ts_path,coverage'))).toEqual([]);
  });

  it('flags the frontend /services/kiwcp/ and any path but /KiWIS/KiWIS', () => {
    expect(kiwisUrlProblems(good.replace('/services/KiWIS/KiWIS', '/services/kiwcp/KiWIS/KiWIS'))).toEqual(['kiwcp']);
    expect(
      kiwisUrlProblems('https://hydrometrie.wallonie.be/services/kiwcp/data/hDayOffsetPub.json?format=json'),
    ).toEqual(['kiwcp', 'path']);
    expect(kiwisUrlProblems(good.replace('/services/KiWIS/KiWIS', '/other'))).toEqual(['path']);
  });

  it('flags a wildcard, however it is spelt', () => {
    expect(kiwisUrlProblems(`${good}&ts_path=DCENN/L6660/*/Cmd.*`)).toEqual(['wildcard']);
    expect(kiwisUrlProblems(`${good}&ts_path=DCENN%2A`)).toEqual(['wildcard']);
    expect(kiwisUrlProblems(`${good}&station_name=Maaseik*`)).toEqual(['wildcard']);
  });

  it('flags a value request that is not in UTC (a layer too), and only a value request', () => {
    expect(kiwisUrlProblems(good.replace('&timezone=UTC', ''))).toEqual(['timezone']);
    expect(kiwisUrlProblems(good.replace('timezone=UTC', 'timezone=Europe/Brussels'))).toEqual(['timezone']);
    expect(kiwisUrlProblems(good.replace('timezone=UTC', 'timezone=utc'))).toEqual(['timezone']);
    const layer = `https://hydrometrie.wallonie.be/services/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=0&format=json&request=getTimeseriesValueLayer&timeseriesgroup_id=1962373`;
    expect(kiwisUrlProblems(layer)).toEqual(['timezone']);
    expect(kiwisUrlProblems(`${layer}&timezone=UTC`)).toEqual([]);
    expect(kiwisUrlProblems(list('station_no'))).toEqual([]);
  });

  it('flags river_name as a returnfield of a list that is not getStationList (HTTP 500 there)', () => {
    expect(kiwisUrlProblems(list('station_no,river_name,ts_id'))).toEqual(['river_name']);
    expect(kiwisUrlProblems(list('river_name'))).toEqual(['river_name']);
    expect(kiwisUrlProblems(stations)).toEqual([]);
  });

  it('flags a from or to without Z (an offset or a bare date), and a format that is not json', () => {
    expect(kiwisUrlProblems(good.replace(/from=[^&]+/, 'from=2026-08-24T00:00:00%2B01:00'))).toEqual(['from_offset']);
    expect(kiwisUrlProblems(good.replace(/to=[^&]+/, 'to=2026-08-27'))).toEqual(['to_offset']);
    expect(kiwisUrlProblems(good.replace(/from=[^&]+/, 'from=2026-08-24T00:00:00'))).toEqual(['from_offset']);
    expect(kiwisUrlProblems(good.replace('format=json', 'format=csv'))).toEqual(['format']);
    expect(kiwisUrlProblems(good.replace('format=json&', ''))).toEqual(['format']);
  });
});

describe('the strict parsers', () => {
  it('a table whose header names no column is drift', () => {
    expect(() => tableRecords([[]])).toThrow(expect.objectContaining({ code: 'kiwis_header' }));
    expect(() => tableRecords([[], []])).toThrow(expect.objectContaining({ code: 'kiwis_header' }));
  });

  const layerItem = (over: Record<string, unknown> = {}) => ({
    ts_id: 246_052_010,
    timestamp: '2030-01-01T10:10:00.000Z',
    req_timestamp: null,
    ts_value: 1.276,
    station_latitude: 50.5,
    station_longitude: 5.2,
    station_no: '7141',
    station_name: 'HUY',
    stationparameter_no: 'H',
    ts_unitsymbol: 'm',
    ...over,
  });
  const valuesItem = (over: Record<string, unknown> = {}) => ({
    ts_id: '246052010',
    columns: 'Timestamp,Value,Quality Code',
    data: [['2030-01-01T10:10:00.000Z', 1.276, 200]],
    ...over,
  });

  it('ts_id as a number (a layer) and as a string (values) both become the same string', () => {
    expect(parseLayer(bytes([layerItem()]))[0]?.ts_id).toBe('246052010');
    expect(parseValues(bytes([valuesItem()]))[0]?.ts_id).toBe('246052010');
    expect(parseLayer(bytes([layerItem({ ts_id: '246052010' })]))[0]?.ts_id).toBe('246052010');
    expect(parseValues(bytes([valuesItem({ ts_id: 246_052_010 })]))[0]?.ts_id).toBe('246052010');
    for (const bad of [-1, 1.5, 1e12, '12a', '', '1234567890123', null, true])
      expect(() => parseLayer(bytes([layerItem({ ts_id: bad })]))).toThrow(SchemaDrift);
  });

  it('a layer item is strict: an extra or missing field, a latitude out of range or a long name is drift', () => {
    expect(parseLayer(bytes([layerItem({ ts_value: null, timestamp: null })]))[0]?.ts_value).toBeNull();
    expect(parseLayer(bytes([layerItem({ station_latitude: undefined, station_longitude: undefined })]))).toHaveLength(
      1,
    );
    drift(() => parseLayer(bytes([layerItem({ extra: 1 })])), 'unrecognized_keys');
    drift(() => parseLayer(bytes([layerItem({ ts_unitsymbol: undefined })])), 'invalid_type');
    drift(() => parseLayer(bytes([layerItem({ station_latitude: 91 })])), 'too_big');
    drift(() => parseLayer(bytes([layerItem({ station_name: 'x'.repeat(201) })])), 'too_big');
    drift(() => parseLayer(bytes([layerItem({ ts_value: '1.2' })])), 'invalid_type');
    drift(() => parseLayer(bytes([1])), 'invalid_type');
  });

  it('a values item is strict: columns and data are required, a cell is text, a number or null, a row at most 8 wide', () => {
    expect(parseValues(bytes([valuesItem({ data: [] })]))[0]?.data).toEqual([]);
    expect(parseValues(bytes([valuesItem({ data: [['a', 1, null, 'b', 2, 3, 4, 5]] })]))).toHaveLength(1);
    drift(() => parseValues(bytes([valuesItem({ data: [[1, 2, 3, 4, 5, 6, 7, 8, 9]] })])), 'too_big');
    drift(() => parseValues(bytes([valuesItem({ data: [[true]] })])), 'invalid_union');
    drift(() => parseValues(bytes([valuesItem({ data: [[{ a: 1 }]] })])), 'json_too_deep');
    drift(() => parseValues(bytes([valuesItem({ columns: undefined })])), 'invalid_type');
    drift(() => parseValues(bytes([valuesItem({ extra: 1 })])), 'unrecognized_keys');
    drift(() => parseValues(bytes([valuesItem({ columns: 'x'.repeat(201) })])), 'too_big');
  });

  it('an error object in place of an answer is drift, never a partial result', () => {
    const tooMany =
      '{"code":"TooManyResults","message":"Maximum number of timeseries values surpassed. Limit is: 250000"}';
    for (const parse of [parseLayer, parseValues, parseTable]) {
      drift(() => parse(Buffer.from(tooMany)), 'kiwis_too_many_results');
      drift(() => parse(Buffer.from('{"code":"InvalidParameterValue","message":"x"}')), 'kiwis_error');
      drift(() => parse(Buffer.from('{"code":"DatasourceError"}')), 'kiwis_error');
      drift(() => parse(Buffer.from('{"code":"X","message":"m","more":{"a":[1]}}')), 'kiwis_error');
      // Not an error object either: a code that is not text, no code, null, a string, a number.
      for (const doc of ['{"code":5}', '{}', 'null', '"x"', '7', 'true'])
        drift(() => parse(Buffer.from(doc)), 'invalid_type');
    }
  });

  it('bytes that are not UTF-8 or not JSON, and a document over a cap, are drift', () => {
    for (const parse of [parseLayer, parseValues, parseTable]) {
      drift(() => parse(Buffer.from([0xff, 0xfe, 0x5b])), 'encoding');
      drift(() => parse(Buffer.from('')), 'not_json');
      drift(() => parse(Buffer.from('[')), 'not_json');
      drift(() => parse(Buffer.from('[1,]')), 'not_json');
    }
    const flat = (n: number) => Buffer.from(`[${Array.from({ length: n }, () => '0').join(',')}]`);
    drift(() => parseLayer(flat(KIWIS_CAPS.layer.maxItems + 1)), 'too_big');
    drift(() => parseLayer(flat(KIWIS_CAPS.layer.maxNodes + 1)), 'json_too_many_nodes');
    drift(() => parseValues(flat(KIWIS_CAPS.values.maxItems + 1)), 'too_big');
    drift(() => parseTable(flat(KIWIS_CAPS.table.maxItems + 1)), 'too_big');
    drift(() => parseLayer(Buffer.from('[[[[0]]]]')), 'json_too_deep');
    drift(() => parseValues(Buffer.from('[[[[[0]]]]]')), 'json_too_deep');
    drift(() => parseTable(Buffer.from('[[[[0]]]]')), 'json_too_deep');
  });

  it('a list answer is records keyed by its header row; a header that is empty, repeated or not text is drift', () => {
    expect(
      parseTable(
        bytes([
          ['ts_id', 'station_no'],
          ['1', 'a'],
          [2, null],
        ]),
      ),
    ).toEqual([
      { ts_id: '1', station_no: 'a' },
      { ts_id: 2, station_no: null },
    ]);
    expect(parseTable(bytes([['ts_id']]))).toEqual([]);
    expect(tableRecords([['a'], ['b']])).toEqual([{ a: 'b' }]);
    drift(() => parseTable(bytes([])), 'kiwis_no_header');
    drift(
      () =>
        parseTable(
          bytes([
            ['a', 'a'],
            ['1', '2'],
          ]),
        ),
      'kiwis_header',
    );
    drift(
      () =>
        parseTable(
          bytes([
            ['a', ''],
            ['1', '2'],
          ]),
        ),
      'kiwis_header',
    );
    drift(
      () =>
        parseTable(
          bytes([
            ['a', null],
            ['1', '2'],
          ]),
        ),
      'kiwis_header',
    );
    drift(
      () =>
        parseTable(
          bytes([
            ['a', 5],
            ['1', '2'],
          ]),
        ),
      'kiwis_header',
    );
    // An empty list is `["No matches."]`: drift, not zero rows.
    drift(() => parseTable(bytes(['No matches.'])), 'invalid_type');
    drift(() => tableRecords({ code: 'x' }), 'kiwis_error');
  });

  it('a row wider or narrower than the header is drift, and names the row', () => {
    for (const row of [['1', '2', '3'], ['1'], []]) {
      try {
        parseTable(bytes([['a', 'b'], ['1', '2'], row]));
        throw new Error('no drift');
      } catch (err) {
        expect(err).toBeInstanceOf(SchemaDrift);
        expect([(err as SchemaDrift).code, (err as SchemaDrift).path]).toEqual(['kiwis_row_width', '2']);
      }
    }
    // A cell holds at most 20,000 characters (SPW's longest measured 2,204).
    expect(parseTable(bytes([['a'], ['x'.repeat(20_000)]]))).toHaveLength(1);
    drift(() => parseTable(bytes([['a'], ['x'.repeat(20_001)]])), 'too_big');
    drift(() => parseTable(bytes([['a'], [{ a: 1 }]])), 'invalid_union');
  });

  it('columnsOf maps each name to its index and refuses an empty or a repeated name', () => {
    const of = (columns: string) => columnsOf(parseValues(bytes([valuesItem({ columns, data: [] })]))[0] as never);
    expect([...of('Timestamp,Value,Quality Code')]).toEqual([
      ['Timestamp', 0],
      ['Value', 1],
      ['Quality Code', 2],
    ]);
    expect([...of('Quality Code, Timestamp ,Value')]).toEqual([
      ['Quality Code', 0],
      ['Timestamp', 1],
      ['Value', 2],
    ]);
    expect(of('Timestamp').size).toBe(1);
    for (const bad of ['', ',', 'Timestamp,', 'Timestamp,,Value', ' ,Value', 'Value,Value', 'Value, Value', 'a,b,a'])
      drift(() => of(bad), 'kiwis_columns');
  });

  it('arbitrary bytes into the three parsers throw only SchemaDrift', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array().map((u) => Buffer.from(u)),
          fc.jsonValue().map((v) => bytes(v)),
          fc.array(fc.jsonValue(), { maxLength: 5 }).map((a) => bytes(a)),
          fc.array(fc.array(fc.jsonValue({ maxDepth: 1 }), { maxLength: 4 }), { maxLength: 4 }).map((a) => bytes(a)),
        ),
        (b) => {
          for (const parse of [parseLayer, parseValues, parseTable]) {
            try {
              parse(b);
            } catch (err) {
              expect(err).toBeInstanceOf(SchemaDrift);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("BE-3's catch-up expand (adapters/be-3/capture.ts)", () => {
  const valuesItem2 = (data: unknown[][]) => ({ ts_id: '1', columns: 'Timestamp,Value,Quality Code', data });
  const root = (group = '1962373'): Req => ({
    url: `https://hydrometrie.wallonie.be/services/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=0&format=json&request=getTimeseriesList&timeseriesgroup_id=${group}&returnfields=station_no,station_name,ts_id,ts_path,stationparameter_no,ts_unitsymbol,site_no,coverage`,
    method: 'GET',
    variant: `group=${group}`,
    timeout: 'metadata',
  });
  const HEAD = [
    'station_no',
    'station_name',
    'ts_id',
    'ts_path',
    'stationparameter_no',
    'ts_unitsymbol',
    'site_no',
    'coverage',
  ];
  const table = (rows: [string | number, string][]) => [
    HEAD,
    ...rows.map(([id, p], i) => [`S${i}`, 'x', id, 'p', p, 'm', 'DGH', '']),
  ];
  const plan = (
    doc: unknown,
    over: Partial<{
      seed: boolean;
      window: { from: Date; to: Date } | null;
      seen: ReadonlySet<string>;
      req: Req;
      checkUrl: (raw: string) => string | null;
    }> = {},
  ) =>
    (
      adapter.expand?.({
        req: over.req ?? root(),
        doc,
        now: WINDOW.to,
        seen: over.seen ?? new Set(),
        seed: over.seed ?? true,
        window: over.window === undefined ? WINDOW : over.window,
        checkUrl: over.checkUrl ?? ((raw) => raw),
      }) ?? { reqs: [] }
    ).reqs;
  const idsAsked = (reqs: Req[]) => reqs.flatMap((r) => (new URL(r.url).searchParams.get('ts_id') ?? '').split(','));

  it('only the seed has a window to catch up: no request outside a seed or without a window', () => {
    const doc = table([['1', 'H']]);
    expect(plan(doc)).toHaveLength(1);
    expect(plan(doc, { seed: false })).toEqual([]);
    expect(plan(doc, { window: null })).toEqual([]);
    expect(plan(doc, { window: { from: WINDOW.to, to: WINDOW.from } })).toEqual([]);
  });

  it('asks only for the six stored parameters, by digit ts_id', () => {
    expect([...PARAMETERS].sort()).toEqual(['H', 'H_sonde', 'Habs', 'Habs_sonde', 'Q', 'QADM']);
    const reqs = plan(
      table([
        ['100', 'H'],
        ['101', 'H_sonde'],
        ['102', 'Habs'],
        ['103', 'Habs_sonde'],
        ['104', 'Q'],
        ['105', 'QADM'],
        ['106', 'QEtimeuse'],
        ['107', 'h.Mean'],
        ['108', 'W'],
        ['109', 'Hx'],
        ['110', 'h'],
        ['111', 'Q '],
        ['112', ''],
        ['abc', 'H'],
        ['1e5', 'H'],
        ['-5', 'H'],
        ['1,2', 'H'],
        ['1234567890123', 'H'],
        ['', 'H'],
      ]),
    );
    expect(idsAsked(reqs)).toEqual(['100', '101', '102', '103', '104', '105']);
    // A number cell is its digits.
    expect(idsAsked(plan(table([[777, 'Q']])))).toEqual(['777']);
  });

  it('ts_ids are sorted numerically and asked once', () => {
    const reqs = plan(
      table([
        ['1000', 'H'],
        ['999', 'Q'],
        ['20', 'H'],
        ['999', 'Q'],
        ['3', 'QADM'],
      ]),
    );
    expect(idsAsked(reqs)).toEqual(['3', '20', '999', '1000']);
  });

  it('plans calls of at most 100 ts_ids, named values/<group>/<day>/<first ts_id>, with the seen id of its variant', () => {
    const rows = Array.from({ length: 150 }, (_, i): [string, string] => [String(5000 + i), 'H']);
    const reqs = plan(table(rows), { req: root('1962340') });
    expect(reqs.map((r) => r.variant)).toEqual([
      'values/1962340/2026-08-24/5000',
      'values/1962340/2026-08-25/5000',
      'values/1962340/2026-08-26/5000',
      'values/1962340/2026-08-24/5100',
    ]);
    for (const r of reqs) {
      expect(r.seen_id).toBe(r.variant);
      expect(r.method).toBe('GET');
      expect(r).not.toHaveProperty('values');
      expect(kiwisUrlProblems(r.url)).toEqual([]);
      expect((new URL(r.url).searchParams.get('ts_id') ?? '').split(',').length).toBeLessThanOrEqual(MAX_IDS);
    }
  });

  it('a series added before a resumed round shifts the batches: no call of the new batches counts as fetched', () => {
    const rows = Array.from({ length: 150 }, (_, i): [string, string] => [String(5000 + i), 'H']);
    const seen = new Set(plan(table(rows)).map((r) => r.seen_id ?? ''));
    const resumed = plan(table([['4999', 'H'], ...rows]), { seen });
    // Every batch now starts at another ts_id, so every call is asked: none is skipped as if it had been fetched.
    expect(resumed.map((r) => r.variant.split('/')[3])).toEqual(['4999', '4999', '4999', '5099']);
  });

  it('a call already fetched (its seen id) is not asked again', () => {
    const rows = Array.from({ length: 150 }, (_, i): [string, string] => [String(5000 + i), 'H']);
    const all = plan(table(rows));
    const seen = new Set([all[1]?.seen_id ?? '', 'something-else']);
    const rest = plan(table(rows), { seen });
    expect(rest.map((r) => r.variant)).toEqual(all.filter((r) => r.variant !== all[1]?.variant).map((r) => r.variant));
    expect(plan(table(rows), { seen: new Set(all.map((r) => r.seen_id ?? '')) })).toEqual([]);
  });

  it('only KiWIS parameters reach a URL, and the host and path are the root request’s', () => {
    const [r] = plan(table([['5', 'H']]));
    const u = new URL(r?.url ?? '');
    expect(`${u.origin}${u.pathname}`).toBe('https://hydrometrie.wallonie.be/services/KiWIS/KiWIS');
    expect([...u.searchParams.keys()].sort()).toEqual(
      [
        'datasource',
        'format',
        'from',
        'md_returnfields',
        'metadata',
        'request',
        'returnfields',
        'service',
        'timezone',
        'to',
        'ts_id',
        'type',
      ].sort(),
    );
    // The list's other cells (names, paths, coverage) never reach it.
    const hostile = [HEAD, ['S&x=1', 'n&y=2', '5', 'p&z=3', 'H', 'm', 'DGH', '&w=4']];
    const keys = [...new URL(plan(hostile)[0]?.url ?? '').searchParams.keys()];
    expect(keys).toEqual([...new URL(plan(table([['5', 'H']]))[0]?.url ?? '').searchParams.keys()]);
    expect(plan(hostile)[0]?.url).not.toMatch(/%26|S0|=1\b.*=2/);
  });

  it('checkUrl has the last word: a refused call is not planned and an accepted one is the checked URL', () => {
    const doc = table([['5', 'H']]);
    expect(plan(doc, { checkUrl: () => null })).toEqual([]);
    expect(plan(doc, { checkUrl: (raw) => `${raw}&checked=1` })[0]?.url).toMatch(/&checked=1$/);
    const seen: string[] = [];
    plan(doc, {
      checkUrl: (raw) => {
        seen.push(raw);
        return raw;
      },
    });
    expect(seen).toHaveLength(1);
  });

  it('a group id that is not digits, or absent, gives no request', () => {
    const doc = table([['5', 'H']]);
    expect(plan(doc, { req: root('abc') })).toEqual([]);
    expect(plan(doc, { req: root('1;2') })).toEqual([]);
    expect(plan(doc, { req: root('') })).toEqual([]);
    expect(plan(doc, { req: { ...root(), url: root().url.replace('&timeseriesgroup_id=1962373', '') } })).toEqual([]);
  });

  it('a malformed list gives no request: an error object, no header, a bad header, a ragged row, "No matches."', () => {
    expect(plan({ code: 'TooManyResults' })).toEqual([]);
    expect(plan([])).toEqual([]);
    expect(plan(['No matches.'])).toEqual([]);
    expect(plan(null)).toEqual([]);
    expect(plan('x')).toEqual([]);
    expect(
      plan([
        ['ts_id', 'ts_id', 'stationparameter_no'],
        ['1', '1', 'H'],
      ]),
    ).toEqual([]);
    expect(
      plan([
        ['ts_id', '', 'stationparameter_no'],
        ['1', '1', 'H'],
      ]),
    ).toEqual([]);
    expect(plan([HEAD, ['S0', 'x', '5', 'p', 'H']])).toEqual([]);
    expect(plan([HEAD, ['S0', 'x', '5', 'p', 'H', 'm', 'DGH', '', 'extra']])).toEqual([]);
    // A list without the columns names no series.
    expect(
      plan([
        ['a', 'b'],
        ['1', '2'],
      ]),
    ).toEqual([]);
    // A list with no rows names none either.
    expect(plan([HEAD])).toEqual([]);
  });

  it('coverage: the first and last timestamp of a values answer, null for anything else', () => {
    const cover = (doc: unknown) => adapter.coverage?.(doc);
    expect(
      cover([
        valuesItem2([
          ['2030-01-01T00:10:00.000Z', 1, 200],
          ['2030-01-01T00:00:00.000Z', 2, 200],
        ]),
        valuesItem2([['2030-01-01T05:00:00.000+02:00', 3, 200]]),
      ]),
    ).toEqual({ from: '2030-01-01T00:00:00.000Z', to: '2030-01-01T03:00:00.000Z' });
    // The column is found by name.
    expect(cover([{ columns: 'Value,Timestamp', data: [[1, '2030-01-01T00:00:00.000Z']] }])).toEqual({
      from: '2030-01-01T00:00:00.000Z',
      to: '2030-01-01T00:00:00.000Z',
    });
    for (const doc of [
      null,
      {},
      'x',
      [],
      [null, 5, 'x'],
      [{ columns: 'Value', data: [[1]] }],
      [{ columns: 5, data: [] }],
      [{ columns: 'Timestamp', data: 'x' }],
      [{ columns: 'Timestamp', data: [] }],
      [{ columns: 'Timestamp,Value', data: [['garbage', 1], [null, 2], 7] }],
      table([['1', 'H']]),
    ])
      expect(cover(doc)).toBeNull();
    // A garbage row beside good ones is skipped.
    expect(
      cover([
        {
          columns: 'Timestamp,Value',
          data: [
            ['garbage', 1],
            ['2030-01-01T00:00:00.000Z', 2],
          ],
        },
      ]),
    ).toEqual({
      from: '2030-01-01T00:00:00.000Z',
      to: '2030-01-01T00:00:00.000Z',
    });
  });
});
