import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { StationsFile } from '@rws/contracts';
import { FUTURE_SLACK_MS, type Normalised, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { type Drift, driftReport } from '../../src/adapters/nl-2/drift.ts';
import { discover, normalise, SOURCE, TIME } from '../../src/adapters/nl-2/normalise.ts';
import { type Collection, type Feature, JSON_CAPS, parseCollection } from '../../src/adapters/nl-2/parse.ts';
import { LOAD_ADAPTERS } from '../../src/load/adapters.ts';
import { goldenUrl, rawFixture } from './registry.ts';

// NL-2 RWS WFS: parse + discover of the real recorded snapshot and of the
// synthetic DST nights equals the committed golden files (invariant 9), and the
// drift report against the real NL-1 registry. `UPDATE_GOLDEN=1` rewrites them;
// a golden change is reviewed like code. NL-2 stores no observation: every
// fixture normalises to no rows.

const FIXTURES = new URL('../../src/adapters/nl-2/fixtures/', import.meta.url);
/** The DST gate (A§7.4): the loader may list NL-2 only while these and their goldens exist. */
const DST = [
  'nl-2-wfs-dst-fall-back.synthetic',
  'nl-2-wfs-dst-fall-back-first.synthetic',
  'nl-2-wfs-dst-spring-forward.synthetic',
];
const ALL = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.raw'))
  .map((f) => f.slice(0, -'.raw'.length));

const LOBITH_H = 'lobith.bovenrijn.tolkamer/WATHTE/NAP/other:F007';
const LOBITH_Q = 'lobith.bovenrijn.tolkamer/Q/NVT/other:F230';
const EIJSDEN_NAP = 'eijsden.grens/WATHTE/NAP/other:F007';
const EIJSDEN_TAW = 'eijsden.grens/WATHTE/TAW/other:F007';
const EIJSDEN_Q = 'eijsden.grens/Q/NVT/other:F216';
const DRIEL_H = 'driel.boven/WATHTE/NAP/other:F007';
const NIEUWEGEIN_Q = 'nieuwegein.doorslag/Q/NVT/other:F103';
const AADORP_H = 'aadorp/WATHTE/NAP/other:F155';

/** The NL-1 series rows the loader hands the drift report (registry/stations/nl-1.yaml: key and station position). */
const NL1 = new Map(
  StationsFile.parse(
    parseYaml(readFileSync(new URL('../../../../registry/stations/nl-1.yaml', import.meta.url), 'utf8')),
  ).stations.map((r) => [r.provider_key, { key: r.provider_key, lon: r.lon, lat: r.lat }]),
);

const collectionOf = (name: string) => parseCollection(rawFixture('NL-2', name).body);
const real = collectionOf('nl-2-wfs');
const keyOf = (f: Feature) =>
  `${f.properties.CODE}/${f.properties.GROOTHEIDCODE}/${f.properties.HOEDANIGHEIDCODE}/${f.properties.WAARDEBEPALINGSMETHODECODE}`;
const featureOf = (key: string): Feature => {
  const f = real.features.find((x) => keyOf(x) === key);
  if (f === undefined) throw new Error(`no feature ${key}`);
  return f;
};
const labelled = (key: string, label: string): Feature => {
  const f = featureOf(key);
  return { ...f, properties: { ...f.properties, TIJDSTIP_LAATSTE_METING: label } };
};
const withCode = (f: Feature, props: Partial<Feature['properties']>): Feature => ({
  ...f,
  properties: { ...f.properties, ...props },
});
const moved = (f: Feature, lon: number, lat: number): Feature => ({
  ...f,
  geometry: { ...f.geometry, coordinates: [lon, lat] },
});

function golden<T>(name: string, actual: T): T {
  const url = goldenUrl('NL-2', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** The SchemaDrift message of a document, or `parsed`. */
function code(doc: unknown): string {
  try {
    parseCollection(Buffer.from(typeof doc === 'string' ? doc : JSON.stringify(doc)));
  } catch (err) {
    if (err instanceof SchemaDrift) return err.message;
    throw err;
  }
  return 'parsed';
}
const rawDoc = () => JSON.parse(rawFixture('NL-2', 'nl-2-wfs').body.toString('utf8'));
/** The three counts of a complete snapshot of `n` features. */
const counts = (n: number) => ({ totalFeatures: n, numberMatched: n, numberReturned: n });

/** Instant of one discovered series, by key. */
const tsOf = (out: ReturnType<typeof discover>) => Object.fromEntries(out.series.map((s) => [s.key, s.ts]));

describe('golden files (real payload)', () => {
  it('the recorded snapshot: 414 live series; the datum duplicates and the repeated features are counted', () => {
    const out = { discovered: discover(real), drift: driftReport(NL1, real) };
    expect(out).toEqual(golden('nl-2-wfs', out));
    expect(real.features).toHaveLength(434);
    // 434 features: 17 in another datum (12 MSL, 5 TAW, all WATHTE), 3 exact repeats under another feature id.
    const datums = real.features.map((f) => `${f.properties.GROOTHEIDCODE}/${f.properties.HOEDANIGHEIDCODE}`);
    expect(datums.filter((d) => d === 'WATHTE/MSL')).toHaveLength(12);
    expect(datums.filter((d) => d === 'WATHTE/TAW')).toHaveLength(5);
    expect(out.discovered.dropped).toEqual({ datum: 17, duplicate: 3 });
    expect(out.discovered.series).toHaveLength(434 - 17 - 3);
    expect(out.discovered.series.some((s) => /\/(MSL|TAW)\//.test(s.key))).toBe(false);
    for (const station of ['spaanjerd', 'herenlaak', 'eisdenmazenhove.maesbempdergreend']) {
      expect(out.discovered.series.filter((s) => s.key === `${station}/WATHTE/NAP/other:F007`)).toHaveLength(1);
    }
    // Sorted by key in code-unit order, one row per key, every key of four segments.
    const keys = out.discovered.series.map((s) => s.key);
    expect(keys).toEqual([...new Set(keys)].sort());
    for (const k of keys) expect(k.split('/')).toHaveLength(4);
  });

  it('spot checks by hand: Amsterdam summer time minus 2 h, [lon, lat], the NL-1 key format', () => {
    const at = new Map(discover(real).series.map((s) => [s.key, s]));
    // Raw: CODE lobith.bovenrijn.tolkamer, WATHTE, NAP, other:F007, "2026-09-29T15:20:00.000Z", [6.1024,51.8495], 607.
    expect(at.get(LOBITH_H)).toEqual({ key: LOBITH_H, ts: '2026-09-29T13:20:00.000Z', lon: 6.1024, lat: 51.8495 });
    // Raw: eijsden.grens, Q, NVT, other:F216, "2026-09-29T14:30:00.000Z", [5.682,50.758] (Eijsden Q is late, §2.1).
    expect(at.get(EIJSDEN_Q)).toEqual({ key: EIJSDEN_Q, ts: '2026-09-29T12:30:00.000Z', lon: 5.682, lat: 50.758 });
    // Raw (the first feature): nieuwegein.doorslag, Q, NVT, other:F103, "2026-09-29T14:50:00.000Z", [5.089851,52.0323].
    expect(at.get(NIEUWEGEIN_Q)).toEqual({
      key: NIEUWEGEIN_Q,
      ts: '2026-09-29T12:50:00.000Z',
      lon: 5.089851,
      lat: 52.0323,
    });
    // An independent check of the conversion: REST (NL-1, recorded in the same minute) has Lobith H 607 cm at
    // 13:20Z, the value the WFS labels "15:20Z".
    expect(featureOf(LOBITH_H).properties.WAARDE_LAATSTE_METING).toBe(607);
    const rest = JSON.parse(readFileSync(goldenUrl('NL-1', 'nl-1-obs-key'), 'utf8')) as Normalised;
    expect(rest.obs.at(-1)).toMatchObject({ series: LOBITH_H, ts: '2026-09-29T13:20:00.000Z', value: 607 });
    // Every registered NAP or NVT key of NL-1 is in the NL-1 key format the snapshot yields.
    for (const key of NL1.keys()) if (!key.includes('/TAW/')) expect([key, at.has(key)]).toEqual([key, true]);
  });
});

describe('time (catalogue §2.1 pitfall 1)', () => {
  const one = (label: string, timeStamp: string, key = LOBITH_H) =>
    discover({ timeStamp, features: [labelled(key, label)] });

  it('a label "…T21:30:00.000Z" is 19:30Z in summer and 20:30Z in winter', () => {
    expect(one('2026-09-23T21:30:00.000Z', '2026-09-23T19:40:00.000Z').series[0]?.ts).toBe('2026-09-23T19:30:00.000Z');
    expect(one('2026-11-15T21:30:00.000Z', '2026-11-15T20:40:00.000Z').series[0]?.ts).toBe('2026-11-15T20:30:00.000Z');
  });

  it('the collection timeStamp is true UTC; a malformed one is drift', () => {
    expect(one('2026-09-29T15:20:00.000Z', '2026-09-29T15:43:29.024+02:00').series[0]?.ts).toBe(
      '2026-09-29T13:20:00.000Z',
    );
    for (const bad of ['2026-09-29T13:43:29', '29-09-2026 13:43', '']) {
      expect(() => one('2026-09-29T15:20:00.000Z', bad)).toThrow('time_bad_format at timeStamp');
    }
  });

  it('a label with a real offset, without Z or of a date that does not exist is drift, with its path', () => {
    for (const bad of [
      '2026-09-29T15:20:00.000+02:00',
      '2026-09-29T15:20:00',
      '2026-02-30T15:20:00.000Z',
      'gisteren',
    ]) {
      expect(() => one(bad, '2026-09-29T13:43:29.024Z')).toThrow(
        'time_bad_format at features.0.properties.TIJDSTIP_LAATSTE_METING',
      );
    }
  });

  it('an instant more than 15 minutes after timeStamp is dropped as future; 15 minutes is inside the slack', () => {
    expect(FUTURE_SLACK_MS).toBe(15 * 60_000);
    expect(one('2026-09-29T16:00:00.000Z', '2026-09-29T13:45:00.000Z')).toMatchObject({
      series: [{ ts: '2026-09-29T14:00:00.000Z' }],
      dropped: {},
    });
    expect(one('2026-09-29T16:01:00.000Z', '2026-09-29T13:45:00.000Z')).toEqual({ series: [], dropped: { future: 1 } });
  });
});

describe('DST gate (A§7.4)', () => {
  it('the synthetic fall-back and spring-forward fixtures exist and equal their goldens', () => {
    for (const name of DST) {
      const { meta } = rawFixture('NL-2', name);
      expect([name, (meta as { synthetic?: unknown }).synthetic]).toEqual([name, true]);
      const out = discover(collectionOf(name));
      expect(out).toEqual(golden(name, out));
    }
  });

  it('the loader lists NL-2 only while both DST fixtures and their goldens exist', () => {
    expect(TIME).toEqual({
      kind: 'local-labelled-z',
      zone: 'Europe/Amsterdam',
      dst: { gap: 'reject', overlap: 'later' },
    });
    const missing = DST.flatMap((n) => [`${n}.raw`, `${n}.golden.json`]).filter(
      (f) => !existsSync(new URL(f, FIXTURES)),
    );
    expect(Object.hasOwn(LOAD_ADAPTERS, SOURCE) ? missing : []).toEqual([]);
  });

  it('fall-back, snapshot in the second pass of the repeated hour (01:45Z = 02:45 CET)', () => {
    const out = discover(collectionOf('nl-2-wfs-dst-fall-back.synthetic'));
    expect(tsOf(out)).toEqual({
      // 01:50 is before the repeated hour: CEST.
      [LOBITH_H]: '2026-10-24T23:50:00.000Z',
      // 02:00, 02:30, 02:45: the second (CET) occurrence is not after timeStamp (02:45 is timeStamp itself).
      [LOBITH_Q]: '2026-10-25T01:00:00.000Z',
      [EIJSDEN_NAP]: '2026-10-25T01:30:00.000Z',
      [EIJSDEN_Q]: '2026-10-25T01:45:00.000Z',
      // 02:50: the second occurrence (01:50Z) is after timeStamp, so the first (CEST) one.
      [DRIEL_H]: '2026-10-25T00:50:00.000Z',
      // 03:00 CET is timeStamp + 15 min: inside the slack.
      [NIEUWEGEIN_Q]: '2026-10-25T02:00:00.000Z',
    });
    // 03:10 CET is 02:10Z, 25 min after timeStamp.
    expect(out.dropped).toEqual({ future: 1 });
    expect(out.series.map((s) => s.key)).not.toContain(AADORP_H);
  });

  it('fall-back, snapshot in the first pass of the repeated hour (00:45Z = 02:45 CEST)', () => {
    const out = discover(collectionOf('nl-2-wfs-dst-fall-back-first.synthetic'));
    expect(tsOf(out)).toEqual({
      // 01:40 is before the repeated hour: CEST.
      [LOBITH_H]: '2026-10-24T23:40:00.000Z',
      // 02:00, 02:30, 02:45: the second occurrence is after timeStamp, so the first.
      [LOBITH_Q]: '2026-10-25T00:00:00.000Z',
      [EIJSDEN_NAP]: '2026-10-25T00:30:00.000Z',
      [EIJSDEN_Q]: '2026-10-25T00:45:00.000Z',
      // 02:55: both occurrences are after timeStamp; the first is 10 min after it, inside the slack.
      [DRIEL_H]: '2026-10-25T00:55:00.000Z',
    });
    // 03:05 CET is 02:05Z, 80 min after timeStamp.
    expect(out.dropped).toEqual({ future: 1 });
  });

  it('spring forward (2027-03-28): a label in the missing hour is dropped as dst_gap, never drift', () => {
    const out = discover(collectionOf('nl-2-wfs-dst-spring-forward.synthetic'));
    expect(tsOf(out)).toEqual({
      // The evening before: CET.
      [LOBITH_H]: '2027-03-27T20:30:00.000Z',
      // 01:50 and 01:59 CET, just before the gap.
      [LOBITH_Q]: '2027-03-28T00:50:00.000Z',
      [EIJSDEN_NAP]: '2027-03-28T00:59:00.000Z',
      // 02:00 and 02:30 (EIJSDEN_Q, DRIEL_H) do not exist. 03:00 and 03:40 CEST.
      [NIEUWEGEIN_Q]: '2027-03-28T01:00:00.000Z',
      [AADORP_H]: '2027-03-28T01:40:00.000Z',
    });
    expect(out.dropped).toEqual({ dst_gap: 2 });
  });
});

describe('NL-2 never yields observation rows', () => {
  it.each(ALL)('%s: no observation, no gauge zero, nothing unknown', (name) => {
    const out = normalise(collectionOf(name));
    expect(out).toEqual({ obs: [], gaugeZeros: [], dropped: discover(collectionOf(name)).dropped, unknown: 0 });
  });

  it('the loader runs it with every recorded and synthetic fixture', () => {
    const spec = LOAD_ADAPTERS[SOURCE]?.specs['nl-2-wfs'];
    for (const name of ALL) {
      const out = spec?.run(rawFixture('NL-2', name).body, {
        registry: new Map(),
        fetchedAt: 0,
        variant: '',
        unitMismatch: new Set(),
      });
      expect([name, out?.obs, out?.gaugeZeros]).toEqual([name, [], []]);
    }
    expect(spec?.driftSource).toBe('NL-1');
  });
});

describe('empty and error payloads', () => {
  it('an empty collection is valid and discovers nothing', () => {
    const out = discover(collectionOf('nl-2-wfs-empty.synthetic'));
    expect(out).toEqual(golden('nl-2-wfs-empty.synthetic', out));
    expect(out).toEqual({ series: [], dropped: {} });
  });

  it('a WFS exception report, a truncated body, an HTML page and an empty body are not JSON', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1" ' +
      'version="2.0.0"><ows:Exception exceptionCode="InvalidParameterValue"><ows:ExceptionText>x</ows:ExceptionText>' +
      '</ows:Exception></ows:ExceptionReport>';
    const body = rawFixture('NL-2', 'nl-2-wfs').body.toString('utf8');
    for (const doc of [xml, body.slice(0, 100_000), '<html><body>Service Unavailable</body></html>', '']) {
      expect(code(doc)).toBe('not_json');
    }
  });
});

describe('strict schema', () => {
  const drift = (change: (d: ReturnType<typeof rawDoc>) => void) => {
    const d = rawDoc();
    change(d);
    return code(d);
  };
  it('every refusal has a fixed code and a schema path', () => {
    expect(drift(() => {})).toBe('parsed');
    expect(drift((d) => (d.features[3].properties.STATUSWAARDE = 'Ongecontroleerd'))).toBe(
      'unrecognized_keys at features.3.properties',
    );
    expect(drift((d) => (d.features[3].bbox = [0, 0, 1, 1]))).toBe('unrecognized_keys at features.3');
    expect(drift((d) => delete d.features[3].properties.CODE)).toBe('invalid_type at features.3.properties.CODE');
    expect(drift((d) => (d.features[3].properties.CODE = 'x'.repeat(81)))).toBe(
      'too_big at features.3.properties.CODE',
    );
    expect(drift((d) => (d.features[3].properties.KWALITEITSWAARDE_CODE = 'AB'))).toBe(
      'invalid_format at features.3.properties.KWALITEITSWAARDE_CODE',
    );
    expect(drift((d) => (d.features[3].properties.WAARDE_LAATSTE_METING = null))).toBe(
      'invalid_type at features.3.properties.WAARDE_LAATSTE_METING',
    );
    expect(drift((d) => (d.crs.properties.name = 'urn:ogc:def:crs:EPSG::28992'))).toBe(
      'invalid_value at crs.properties.name',
    );
    expect(drift((d) => (d.features[3].geometry.type = 'MultiPoint'))).toBe(
      'invalid_value at features.3.geometry.type',
    );
    expect(drift((d) => (d.features[3].geometry = null))).toBe('invalid_type at features.3.geometry');
    expect(drift((d) => (d.type = 'Feature'))).toBe('invalid_value at type');
    expect(drift((d) => (d.timeStamp = 1))).toBe('invalid_type at timeStamp');
  });

  it('coordinates: exactly two finite numbers, lon then lat, in range', () => {
    const at = (coordinates: unknown) => drift((d) => (d.features[3].geometry.coordinates = coordinates));
    // A latitude where the longitude should be, north of the pole; a projected (RD) pair.
    expect(at([5.1, 95])).toBe('too_big at features.3.geometry.coordinates.1');
    expect(at([155000, 463000])).toBe('too_big at features.3.geometry.coordinates.0');
    expect(at([-181, 52])).toBe('too_small at features.3.geometry.coordinates.0');
    expect(at([5.1, 52.1, 0])).toBe('too_big at features.3.geometry.coordinates');
    expect(at([5.1])).toBe('too_small at features.3.geometry.coordinates');
    // JSON cannot carry NaN or Infinity; a provider could send them as strings.
    expect(at(['NaN', 52.1])).toBe('invalid_type at features.3.geometry.coordinates.0');
    expect(at([5.1, 'Infinity'])).toBe('invalid_type at features.3.geometry.coordinates.1');
  });

  it('a paged or capped answer is not a snapshot', () => {
    expect(drift((d) => (d.numberMatched = 941_735))).toBe('invalid_value at numberReturned');
    expect(drift((d) => (d.numberReturned = 433))).toBe('invalid_value at numberReturned');
    expect(drift((d) => (d.totalFeatures = 435))).toBe('invalid_value at numberReturned');
    expect(drift((d) => d.features.pop())).toBe('invalid_value at numberReturned');
    expect(drift((d) => Object.assign(d, counts(433)).features.pop())).toBe('parsed');
  });

  it('bounded: too many features, too many values and too deep are refused before any feature is parsed', () => {
    const d = rawDoc();
    const [first] = d.features;
    const of = (n: number, item: unknown = first) =>
      code({ ...d, ...counts(n), features: Array.from({ length: n }, () => item) });
    expect(of(JSON_CAPS.maxFeatures)).toBe('parsed');
    expect(of(JSON_CAPS.maxFeatures + 1)).toBe('too_big at features');
    // Short features: the cap on the array, not on the values, stops them.
    expect(of(JSON_CAPS.maxFeatures + 1, 0)).toBe('too_big at features');
    expect(of(JSON_CAPS.maxNodes)).toBe('json_too_many_nodes');
    expect(code(Array.from({ length: JSON_CAPS.maxNodes }, () => 0))).toBe('json_too_many_nodes');
    expect(code(`${'['.repeat(JSON_CAPS.maxDepth + 1)}${']'.repeat(JSON_CAPS.maxDepth + 1)}`)).toBe('json_too_deep');
    expect(code({ ...d, features: [[[[[[[[0]]]]]]]] })).toBe('json_too_deep');
  });
});

describe('rules', () => {
  const stamp = '2026-09-29T13:43:29.024Z';
  const run = (...features: Feature[]) => discover({ timeStamp: stamp, features });

  it('only WATHTE in NAP and Q in NVT; an inherited name is no quantity or datum', () => {
    const h = featureOf(LOBITH_H);
    const q = featureOf(LOBITH_Q);
    for (const GROOTHEIDCODE of ['STROOMSHD', 'T', 'constructor', '__proto__', 'toString', '']) {
      expect([GROOTHEIDCODE, run(withCode(h, { GROOTHEIDCODE }))]).toEqual([
        GROOTHEIDCODE,
        { series: [], dropped: { quantity: 1 } },
      ]);
    }
    for (const HOEDANIGHEIDCODE of ['TAW', 'MSL', 'NVT', 'PLAATSLR', 'constructor']) {
      expect(run(withCode(h, { HOEDANIGHEIDCODE })).dropped).toEqual({ datum: 1 });
    }
    for (const HOEDANIGHEIDCODE of ['NAP', 'TAW']) {
      expect(run(withCode(q, { HOEDANIGHEIDCODE })).dropped).toEqual({ datum: 1 });
    }
    // A station code that names an inherited property is an ordinary key.
    expect(run(withCode(h, { CODE: 'constructor' })).series.map((s) => s.key)).toEqual([
      'constructor/WATHTE/NAP/other:F007',
    ]);
  });

  it('a key listed twice is one series at its newest instant, in either order', () => {
    const older = moved(labelled(LOBITH_H, '2026-09-29T15:10:00.000Z'), 6.2, 51.9);
    const newer = labelled(LOBITH_H, '2026-09-29T15:20:00.000Z');
    const expected = {
      series: [{ key: LOBITH_H, ts: '2026-09-29T13:20:00.000Z', lon: 6.1024, lat: 51.8495 }],
      dropped: { duplicate: 1 },
    };
    expect(run(older, newer)).toEqual(expected);
    expect(run(newer, older)).toEqual(expected);
    expect(run(newer, newer, newer)).toEqual({ ...expected, dropped: { duplicate: 2 } });
  });

  it('the output is sorted by key in code-unit order, whatever the feature order', () => {
    const features = [...real.features].reverse();
    expect(discover({ timeStamp: real.timeStamp, features })).toEqual(discover(real));
    const upper = withCode(featureOf(LOBITH_H), { CODE: 'Zwolle' });
    expect(run(featureOf(LOBITH_H), upper).series.map((s) => s.key)).toEqual([
      'Zwolle/WATHTE/NAP/other:F007',
      LOBITH_H,
    ]);
  });
});

describe('drift report (NL-1 registry)', () => {
  const withFeatures = (features: Feature[]): Collection => ({ timeStamp: real.timeStamp, features });
  const replace = (key: string, f: Feature | null) =>
    withFeatures(real.features.flatMap((x) => (keyOf(x) === key ? (f === null ? [] : [f]) : [x])));

  it('the recorded snapshot: two live series of registered stations are unregistered; nothing vanished or moved', () => {
    expect(driftReport(NL1, real)).toEqual({
      // Driel Q is on NL-1's stale list (a stale value under a fresh timestamp); Epen Q is not in the seed list.
      unregistered: ['driel.boven/Q/NVT/other:F103', 'epen.geul.cottessen/Q/NVT/other:F007'],
      vanished: [],
      changed: [],
    });
  });

  it('a station moved by 0.001° is changed (position); 0.00001° is rounding', () => {
    const f = featureOf(LOBITH_H);
    const [lon, lat] = f.geometry.coordinates;
    expect(driftReport(NL1, replace(LOBITH_H, moved(f, lon + 0.001, lat))).changed).toEqual([
      { key: LOBITH_H, field: 'position', declared: '6.102400,51.849500', published: '6.103400,51.849500' },
    ]);
    expect(driftReport(NL1, replace(LOBITH_H, moved(f, lon, lat - 0.001))).changed).toEqual([
      { key: LOBITH_H, field: 'position', declared: '6.102400,51.849500', published: '6.102400,51.848500' },
    ]);
    expect(driftReport(NL1, replace(LOBITH_H, moved(f, lon + 0.00001, lat - 0.00001))).changed).toEqual([]);
    // Swapped axes are in range for the schema; the registry position tells.
    expect(driftReport(NL1, replace(LOBITH_H, moved(f, lat, lon))).changed).toMatchObject([
      { key: LOBITH_H, field: 'position' },
    ]);
    // A registered row without a position is not compared.
    const unplaced = new Map(NL1);
    unplaced.set(LOBITH_H, { key: LOBITH_H, lon: null, lat: null });
    expect(driftReport(unplaced, replace(LOBITH_H, moved(f, lon + 1, lat))).changed).toEqual([]);
  });

  it('a registered series the snapshot no longer lists has vanished; the TAW twin never has', () => {
    expect(NL1.has(EIJSDEN_TAW)).toBe(true);
    expect(driftReport(NL1, replace(LOBITH_Q, null)).vanished).toEqual([LOBITH_Q]);
    // A series dropped by the time rule is not listed either.
    expect(driftReport(NL1, replace(LOBITH_Q, labelled(LOBITH_Q, '2026-09-29T18:00:00.000Z'))).vanished).toEqual([
      LOBITH_Q,
    ]);
    expect(driftReport(NL1, replace(EIJSDEN_TAW, null)).vanished).toEqual([]);
    const empty = driftReport(NL1, collectionOf('nl-2-wfs-empty.synthetic'));
    expect(empty.vanished).toEqual([...NL1.keys()].filter((k) => !k.includes('/TAW/')).sort());
    expect(empty.vanished).not.toContain(EIJSDEN_TAW);
  });

  it('only series of registered stations are reported; an inherited name is no station', () => {
    const h = featureOf(LOBITH_H);
    const extra = ['nowhere', 'constructor', '__proto__', 'hasOwnProperty'].map((CODE) => withCode(h, { CODE }));
    const lobithNew = withCode(h, { WAARDEBEPALINGSMETHODECODE: 'other:F999' });
    expect(driftReport(NL1, withFeatures([...real.features, ...extra, lobithNew])).unregistered).toEqual([
      'driel.boven/Q/NVT/other:F103',
      'epen.geul.cottessen/Q/NVT/other:F007',
      'lobith.bovenrijn.tolkamer/WATHTE/NAP/other:F999',
    ]);
  });

  it('every list is sorted, holds each key once, is capped at 200 and names no station', () => {
    const h = withCode(featureOf(LOBITH_H), { NAAM: 'NAAM-CANARY' });
    const registry = new Map(NL1);
    const features = real.features.map((f) => withCode(f, { NAAM: 'NAAM-CANARY' }));
    for (let i = 299; i >= 0; i--) {
      const n = String(i).padStart(3, '0');
      // Gone: registered, not listed. New: a live method of a registered station. Moved: listed twice, 1° away.
      const gone = `lobith.bovenrijn.tolkamer/WATHTE/NAP/gone:${n}`;
      const at = `moved.${n}/WATHTE/NAP/other:F007`;
      registry.set(gone, { key: gone, lon: 0, lat: 0 });
      registry.set(at, { key: at, lon: 6.1024, lat: 51.8495 });
      const away = moved(withCode(h, { CODE: `moved.${n}` }), 7.1024, 51.8495);
      features.push(withCode(h, { WAARDEBEPALINGSMETHODECODE: `new:${n}` }), away, away);
    }
    const report: Drift = driftReport(registry, withFeatures(features));
    for (const list of [report.unregistered, report.vanished, report.changed.map((c) => c.key)]) {
      expect(list).toHaveLength(200);
      expect(list).toEqual([...new Set(list)].sort());
    }
    expect(JSON.stringify(report)).not.toContain('NAAM-CANARY');
  });
});

describe('property and fuzz tests', () => {
  const MINUTE = 60_000;
  const ZONE = 'Europe/Amsterdam';
  /** Distinct live series of the real snapshot, as templates. */
  const templates = discover(real).series.map((s) => featureOf(s.key));
  const TRANSITIONS = [Date.UTC(2026, 2, 29), Date.UTC(2026, 9, 25), Date.UTC(2027, 2, 28), Date.UTC(2027, 9, 31)];
  /** A wall-clock label in 2026–2027, often on a transition day; its digits are those of `ms` in UTC. */
  const label = fc
    .oneof(
      fc.integer({ min: Date.UTC(2026, 0, 1) / MINUTE, max: Date.UTC(2028, 0, 1) / MINUTE - 1 }).map((m) => m * MINUTE),
      fc
        .tuple(fc.constantFrom(...TRANSITIONS), fc.integer({ min: 0, max: 24 * 60 - 1 }))
        .map(([day, m]) => day + m * MINUTE),
    )
    .map((ms) => new Date(ms).toISOString());
  /**
   * A timestamp from 4 h before to 2 h after the label read as UTC (before, between and after its candidates,
   * which are 1 h and 2 h before it), often exactly at a candidate or at a candidate + 15 min.
   */
  const around = (text: string) =>
    fc
      .oneof(fc.integer({ min: -4 * 3600, max: 2 * 3600 }), fc.constantFrom(-7200, -6300, -3600, -2700))
      .map((s) => new Date(Date.parse(text) + s * 1000).toISOString());

  /** Every UTC instant whose Amsterdam wall clock is the label (0, 1 or 2), without the parser under test. */
  const candidates = (text: string): number[] => {
    const local = Temporal.PlainDateTime.from(text.slice(0, -1));
    return ['+02:00', '+01:00']
      .map((offset) => Temporal.Instant.from(`${local.toString()}${offset}`))
      .filter((t) => t.toZonedDateTimeISO(ZONE).toPlainDateTime().equals(local))
      .map((t) => t.epochMilliseconds);
  };

  it('each label resolves to the latest of its Amsterdam candidates not after timeStamp, or is a counted drop', () => {
    fc.assert(
      fc.property(
        label.chain((l) => fc.tuple(fc.constant(l), around(l))),
        fc.constantFrom(...templates),
        ([text, timeStamp], template) => {
          const f = { ...template, properties: { ...template.properties, TIJDSTIP_LAATSTE_METING: text } };
          const out = discover({ timeStamp, features: [f] });
          const stamp = Date.parse(timeStamp);
          const c = candidates(text);
          if (c.length === 0) {
            expect(out).toEqual({ series: [], dropped: { dst_gap: 1 } });
            return;
          }
          // No candidate at or before timeStamp: the earliest, which the future rule then judges.
          const pick = c.filter((t) => t <= stamp).sort((a, b) => b - a)[0] ?? Math.min(...c);
          if (pick > stamp + 15 * MINUTE) {
            expect(out).toEqual({ series: [], dropped: { future: 1 } });
            return;
          }
          const [lon, lat] = f.geometry.coordinates;
          expect(out).toEqual({ series: [{ key: keyOf(f), ts: new Date(pick).toISOString(), lon, lat }], dropped: {} });
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('discover never returns an instant after timeStamp + 15 min, and accounts for every feature', () => {
    fc.assert(
      fc.property(
        fc.array(label, { maxLength: 30 }),
        label.chain((l) => around(l)),
        (labels, timeStamp) => {
          const features = labels.map((l, i) => {
            const t = templates[i] as Feature;
            return { ...t, properties: { ...t.properties, TIJDSTIP_LAATSTE_METING: l } };
          });
          const out = discover({ timeStamp, features });
          for (const s of out.series) expect(Date.parse(s.ts)).toBeLessThanOrEqual(Date.parse(timeStamp) + 15 * MINUTE);
          const drops = Object.values(out.dropped).reduce((a, b) => a + b, 0);
          expect(out.series.length + drops).toBe(features.length);
          expect(normalise({ timeStamp, features })).toMatchObject({ obs: [], gaugeZeros: [], unknown: 0 });
        },
      ),
      { numRuns: 300 },
    );
  });

  it('parse never throws anything but SchemaDrift on arbitrary JSON', () => {
    const { features: _, ...envelope } = rawDoc();
    fc.assert(
      fc.property(fc.jsonValue(), (doc) => {
        for (const d of [doc, { ...envelope, features: doc }, { ...envelope, ...counts(1), features: [doc] }]) {
          try {
            normalise(parseCollection(Buffer.from(JSON.stringify(d))));
          } catch (err) {
            expect(err).toBeInstanceOf(SchemaDrift);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  // 5.6 s under v8 coverage on a CI runner (2026-10-02, main and #52): over the 5 s default.
  it('a mutated real payload is either still valid or a SchemaDrift, never a crash or a row', {
    timeout: 30_000,
  }, () => {
    const doc = rawDoc();
    const mutation = fc.tuple(
      fc.constantFrom('envelope', 'feature', 'geometry', 'properties'),
      fc.constantFrom(
        'type',
        'id',
        'coordinates',
        'timeStamp',
        'crs',
        'numberReturned',
        'CODE',
        'GROOTHEIDCODE',
        'HOEDANIGHEIDCODE',
        'TIJDSTIP_LAATSTE_METING',
        'WAARDE_LAATSTE_METING',
      ),
      fc.integer({ min: 0, max: 433 }),
      fc.jsonValue(),
    );
    fc.assert(
      fc.property(mutation, ([part, key, i, junk]) => {
        const copy = structuredClone(doc);
        const f = copy.features[i];
        const target = part === 'envelope' ? copy : part === 'feature' ? f : f[part];
        target[key] = junk;
        try {
          const c = parseCollection(Buffer.from(JSON.stringify(copy)));
          expect(normalise(c)).toMatchObject({ obs: [], gaugeZeros: [], unknown: 0 });
          driftReport(NL1, c);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 200 },
    );
  });
});
