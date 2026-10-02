import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractDataToJson } from '../apps/server/src/http/guards.ts';
import { Refusal, synthesize, synthesizeFromExport, VERBATIM } from '../scripts/synthesize-fixture.ts';

// The export form of scripts/synthesize-fixture.ts (P5c): a fake export in a temp directory, an injectable output
// root, so nothing is ever written under apps/. Every value below is invented.

const tmp = mkdtempSync(join(tmpdir(), 'synth-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
let counter = 0;

/** A fresh export directory holding the given payloads of one spec (and a fresh output root). */
function exportOf(
  source: string,
  spec: string,
  payloads: { body: string; start?: string; variant?: string; sha?: string }[],
) {
  counter += 1;
  const from = join(tmp, `export-${counter}`);
  const outRoot = join(tmp, `out-${counter}`);
  mkdirSync(from, { recursive: true });
  payloads.forEach((p, i) => {
    const body = Buffer.from(p.body);
    writeFileSync(join(from, `${spec}-${i + 1}.raw`), body);
    writeFileSync(
      join(from, `${spec}-${i + 1}.line.json`),
      JSON.stringify({
        source,
        spec,
        variant: p.variant ?? 'default',
        sha256: p.sha ?? sha256(body),
        key: `raw/${source}/${spec}/${i + 1}.zst`,
        status: 200,
        fetched_at: { start: p.start ?? `2026-10-0${i + 1}T10:00:00Z`, end: `2026-10-0${i + 1}T10:00:01Z` },
      }),
    );
  });
  return { from, outRoot };
}

const run = (e: { from: string; outRoot: string }, spec: string, source: string, extra = {}) => {
  const written = synthesizeFromExport({ from: e.from, outRoot: e.outRoot, spec, name: 'test', ...extra });
  const dir = join(e.outRoot, source.toLowerCase(), 'fixtures');
  const file = (suffix: string) => readFileSync(join(dir, `${spec}-test.synthetic.${suffix}`), 'utf8');
  return { written, raw: file('raw'), meta: JSON.parse(file('meta.json')) as Record<string, unknown>, dir };
};

const DAY = 86_400_000;
/** The whole number of days by which `after` lies after `before`, with the same time of day and offset suffix. */
function shiftDays(before: string, after: string): number {
  expect(after.slice(10)).toBe(before.slice(10));
  const days = (Date.parse(after) - Date.parse(before)) / DAY;
  expect(Number.isInteger(days)).toBe(true);
  return days;
}

// Each run loads the capture registry (a few hundred ms): the whole suite runs these under load.
describe('the export form of synthesize-fixture', { timeout: 30_000 }, () => {
  it('a BE-3 layer: identifiers kept, values, names and coordinates generated, timestamps shifted by one constant', () => {
    const layer = [
      {
        ts_id: 905579408,
        timestamp: '2026-09-29T10:20:00.000+02:00',
        req_timestamp: null,
        ts_value: 3.25,
        station_latitude: 50.4561,
        station_longitude: 5.1234,
        station_no: '5902',
        station_name: 'Mijn Station',
        stationparameter_no: '1000',
        ts_unitsymbol: 'm3/s',
      },
      {
        ts_id: 689409637,
        timestamp: '2026-09-29T08:30:00.000Z',
        req_timestamp: null,
        ts_value: 27.25,
        station_latitude: 49.9,
        station_longitude: 4.8,
        station_no: '5277',
        station_name: 'Ander Station',
        stationparameter_no: '1001',
        ts_unitsymbol: 'cm',
      },
    ];
    const body = JSON.stringify(layer);
    const { written, raw, meta } = run(exportOf('BE-3', 'be-3-values', [{ body }]), 'be-3-values', 'BE-3');
    const out = JSON.parse(raw) as typeof layer;
    expect(out).toHaveLength(2);
    out.forEach((o, i) => {
      const was = layer[i] as (typeof layer)[number];
      for (const k of ['ts_id', 'station_no', 'stationparameter_no', 'ts_unitsymbol'] as const)
        expect(o[k]).toBe(was[k]);
      for (const k of ['ts_value', 'station_name', 'station_latitude', 'station_longitude'] as const)
        expect(o[k]).not.toBe(was[k]);
      expect(o.station_name).toMatch(/^synthetic-\d+$/);
      expect(typeof o.ts_value).toBe('number');
      expect(o.req_timestamp).toBeNull();
    });
    const [d1, d2] = [
      shiftDays(layer[0]?.timestamp as string, out[0]?.timestamp as string),
      shiftDays(layer[1]?.timestamp as string, out[1]?.timestamp as string),
    ];
    expect(d1).toBe(d2);
    expect(d1).toBeGreaterThanOrEqual(1000);
    expect(d1).toBeLessThanOrEqual(2000);
    // The raw bytes differ from the source, and the meta says where it came from (never a `from`).
    expect(sha256(Buffer.from(raw))).not.toBe(sha256(Buffer.from(body)));
    expect(meta).toEqual({
      spec: 'be-3-values',
      source: 'BE-3',
      synthetic: true,
      derived_from: 'an archived payload (owner audience: not committed)',
      values: expect.any(String),
      status: 200,
      variant: 'default',
      archive_key: 'raw/BE-3/be-3-values/1.zst',
      source_sha256: sha256(Buffer.from(body)),
    });
    expect(meta).not.toHaveProperty('from');
    expect(written.map((w) => w.path.split('/').pop())).toEqual([
      'be-3-values-test.synthetic.raw',
      'be-3-values-test.synthetic.meta.json',
    ]);
    expect(written.map((w) => w.bytes)).toEqual([raw.length, Buffer.byteLength(`${JSON.stringify(meta, null, 2)}\n`)]);
  });

  it('a BE-3 getTimeseriesValues item: quality codes, null and -1 kept; values and timestamps generated', () => {
    const item = {
      ts_id: '905579408',
      ts_path: '1/5902/Q/15m.Cmd.P',
      ts_unitsymbol: 'm³/s',
      columns: 'Timestamp,Value,Quality Code',
      rows: '4',
      data: [
        ['2026-09-29T10:00:00.000+02:00', 4.25, 100],
        ['2026-09-29T10:15:00.000+02:00', 4.5, 100],
        ['2026-09-29T10:30:00.000+02:00', 0, 200],
        ['2026-09-29T10:45:00.000+02:00', null, -1],
        ['2026-09-29T11:00:00.000+02:00', -1, 255],
      ],
    };
    const { raw } = run(exportOf('BE-3', 'be-3-values', [{ body: JSON.stringify([item]) }]), 'be-3-values', 'BE-3');
    const [out] = JSON.parse(raw) as (typeof item)[];
    expect(out?.ts_path).toBe(item.ts_path);
    expect(out?.columns).toBe(item.columns);
    expect(out?.data.map((r) => r[2])).toEqual(item.data.map((r) => r[2]));
    expect(out?.data[3]?.[1]).toBeNull();
    expect(out?.data[4]?.[1]).toBe(-1);
    expect(out?.data[2]?.[1]).toBe(0);
    for (const i of [0, 1]) expect(out?.data[i]?.[1]).not.toBe(item.data[i]?.[1]);
    const days = item.data.map((r, i) => shiftDays(r[0] as string, out?.data[i]?.[0] as string));
    expect(new Set(days).size).toBe(1);
  });

  it('a KiWIS table: header row and registry columns kept, keep rows only, other cells generated', () => {
    const header = ['station_no', 'station_name', 'station_carteasting', 'river_name', 'station_gauge_datum_unit'];
    const rows = [
      ['5902', 'Mijn Station', '185.41 m NN', 'Mijn Rivier', 'm'],
      ['5277', 'Ander Station', '12,83', 'Andere Rivier', 'cm'],
      ['5111', 'Derde Station', '01.111996', 'Derde Rivier', 'm'],
    ];
    const { raw } = run(
      exportOf('BE-3', 'be-3-meta', [{ body: JSON.stringify([header, ...rows]) }]),
      'be-3-meta',
      'BE-3',
      { keep: 2 },
    );
    const out = JSON.parse(raw) as string[][];
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(header);
    out.slice(1).forEach((r, i) => {
      const was = rows[i] as string[];
      expect([r[0], r[4]]).toEqual([was[0], was[4]]);
      expect(r[1]).toMatch(/^synthetic-\d+$/);
      expect(r[3]).toMatch(/^synthetic-\d+$/);
    });
    // A number with unit text keeps its shape and its letters; only the digits change.
    expect(out[1]?.[2]).toMatch(/^\d{3}\.\d{2} m NN$/);
    expect(out[1]?.[2]).not.toBe('185.41 m NN');
    expect(out[2]?.[2]).toMatch(/^\d{2},\d{2}$/);
  });

  it('an LU-2 file: its enumerations kept, its names and values generated', () => {
    const file = [
      {
        ts_path: 'Alzette/Hesperange/W/15m',
        ts_unitsymbol: 'cm',
        parametertype_name: 'Wasserstand',
        station_name: 'Hesperange',
        columns: 'Timestamp,Value',
        rows: '3',
        data: [
          ['2026-09-29T10:00:00.000+02:00', 85.5],
          ['2026-09-29T10:15:00.000+02:00', 86.25],
        ],
      },
    ];
    const { raw } = run(exportOf('LU-2', 'lu-2-json', [{ body: JSON.stringify(file) }]), 'lu-2-json', 'LU-2');
    const [out] = JSON.parse(raw) as typeof file;
    for (const k of ['ts_path', 'ts_unitsymbol', 'parametertype_name', 'columns', 'rows'] as const)
      expect(out?.[k]).toBe(file[0]?.[k]);
    expect(out?.station_name).toBe('synthetic-1');
    expect(out?.data[0]?.[1]).not.toBe(85.5);
    expect(shiftDays('2026-09-29T10:00:00.000+02:00', out?.data[0]?.[0] as string)).toBeGreaterThanOrEqual(1000);
  });

  it('an LU-4 page: the attribute is re-emitted with &#34; and its enumerations kept', () => {
    const doc = {
      id: 'mondorf',
      jsonFile: 'mondorf.json',
      forecastsLimit: '12',
      label: 'Mondorf',
      stationName: 'Mondorf-les-Bains',
      vigilanceThreshold: 47,
      showImage: true,
      levelsMax: [
        { value: 0, label: 'Cote de vigilance jaune' },
        { value: 321.5, label: 'Cote de vigilance orange 321 cm' },
      ],
    };
    const attr = JSON.stringify(doc).replace(/"/g, '&#34;');
    const body = `<!DOCTYPE html><html><body><cmp-dashboard-station data-to-json="${attr}"></cmp-dashboard-station></body></html>`;
    const { raw } = run(exportOf('LU-4', 'lu-4-pages', [{ body }]), 'lu-4-pages', 'LU-4');
    expect(raw).toContain('<cmp-dashboard-station class="synthetic" data-to-json="{&#34;id&#34;:&#34;mondorf&#34;');
    expect(raw).not.toMatch(/data-to-json="[^"]*"[^"]*"/);
    const out = extractDataToJson(Buffer.from(raw)) as typeof doc;
    expect([out.id, out.jsonFile, out.forecastsLimit, out.showImage]).toEqual(['mondorf', 'mondorf.json', '12', true]);
    expect(out.stationName).toMatch(/^synthetic-\d+$/);
    expect(out.vigilanceThreshold).not.toBe(47);
    // A label is text that can carry the level itself ("… orange 321 cm"): generated, never kept (P5c review CR-1).
    expect(out.levelsMax.map((l) => l.label)).toEqual([
      expect.stringMatching(/^synthetic-/),
      expect.stringMatching(/^synthetic-/),
    ]);
    expect(raw).not.toContain('321');
    expect(out.levelsMax[0]?.value).toBe(0);
    expect(out.levelsMax[1]?.value).not.toBe(321.5);
  });

  it('keeps verbatim only identifiers and codes: no kept key of any source is a free text (P5c review CR-1)', () => {
    const FREE_TEXT = /label|name|text|info|description|remark|diary|address|adresse|banner|comment/i;
    for (const [source, keys] of Object.entries(VERBATIM))
      for (const key of keys)
        expect([
          source,
          key,
          FREE_TEXT.test(key) &&
            !/^(ts_name|ts_shortname|parametertype_name|stationparameter_name|forecastsFileName)$/.test(key),
        ]).toEqual([source, key, false]);
  });

  it('keeps 9999.0 (number and string), is deterministic, and shifts every timestamp by the same days', () => {
    const times = ['2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z', '2026-03-31T23:50:00.5+01:00'];
    const doc = [{ a: 9999.0, b: '9999.0', c: 7777.5, d: times, e: '2026-06-01T12:00' }];
    const body = Buffer.from(JSON.stringify(doc));
    const one = synthesize('DE-3', 'json', body);
    expect(one.equals(synthesize('DE-3', 'json', body))).toBe(true);
    const [out] = JSON.parse(one.toString()) as typeof doc;
    expect([out?.a, out?.b]).toEqual([9999, '9999.0']);
    expect(out?.c).not.toBe(7777.5);
    const days = times.map((t, i) => shiftDays(t, out?.d[i] as string));
    expect(new Set(days).size).toBe(1);
    // An offset-less time keeps its time of day, and moves by the same days.
    expect(out?.e.slice(10)).toBe('T12:00');
    expect(Date.parse(`${out?.e}Z`) - Date.parse('2026-06-01T12:00Z')).toBe((days[0] as number) * DAY);
  });

  it('picks by fetched_at.start (latest by default, oldest on request) and by variant', () => {
    const e = exportOf('BE-3', 'be-3-values', [
      { body: '[{"ts_value": 1.5}]', start: '2026-10-02T00:00:00Z', variant: 'a' },
      { body: '[{"ts_value": 2.5}]', start: '2026-10-05T00:00:00Z', variant: 'a' },
      { body: '[{"ts_value": 3.5}]', start: '2026-10-09T00:00:00Z', variant: 'b' },
    ]);
    const key = (extra: object) => run(e, 'be-3-values', 'BE-3', { force: true, ...extra }).meta.archive_key;
    expect(key({})).toBe('raw/BE-3/be-3-values/3.zst');
    expect(key({ pick: 'oldest' })).toBe('raw/BE-3/be-3-values/1.zst');
    expect(key({ variant: 'a' })).toBe('raw/BE-3/be-3-values/2.zst');
    expect(key({ variant: 'a', pick: 'oldest' })).toBe('raw/BE-3/be-3-values/1.zst');
    expect(() => key({ variant: 'zz' })).toThrow(Refusal);
  });

  describe('refuses', () => {
    const refusal = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(Refusal);
        return (e as Refusal).code;
      }
      return null;
    };
    const body = '[{"ts_value": 1.5}]';

    it('a spec of a source that is not owner audience, before it looks at the export (64)', () => {
      const e = exportOf('DE-1', 'de-1-basin', [{ body }]);
      expect(refusal(() => synthesizeFromExport({ ...e, spec: 'de-1-basin', name: 'test' }))).toBe(64);
      expect(refusal(() => synthesizeFromExport({ ...e, spec: 'no-such-spec', name: 'test' }))).toBe(64);
      expect(readdirSync(tmp)).not.toContain(`out-${counter}`);
    });

    it('a payload whose sha256 is not the one of its manifest line (1)', () => {
      const e = exportOf('BE-3', 'be-3-values', [{ body, sha: sha256(Buffer.from('another body')) }]);
      expect(refusal(() => synthesizeFromExport({ ...e, spec: 'be-3-values', name: 'test' }))).toBe(1);
      expect(readdirSync(tmp)).not.toContain(`out-${counter}`);
    });

    it('synthetic bytes that equal the source (1)', () => {
      const e = exportOf('BE-3', 'be-3-values', [{ body: '[]' }]);
      expect(refusal(() => synthesizeFromExport({ ...e, spec: 'be-3-values', name: 'test' }))).toBe(1);
    });

    it('an existing output unless --force (1), and a name that is not lowercase words (64)', () => {
      const e = exportOf('BE-3', 'be-3-values', [{ body }]);
      const o = { ...e, spec: 'be-3-values', name: 'test' };
      synthesizeFromExport(o);
      expect(refusal(() => synthesizeFromExport(o))).toBe(1);
      expect(refusal(() => synthesizeFromExport({ ...o, force: true }))).toBeNull();
      for (const name of ['Test', 'a_b', '-a', 'a--b', '', '../x']) {
        expect(refusal(() => synthesizeFromExport({ ...o, name }))).toBe(64);
      }
    });

    it('a body that is not JSON, without printing it (1)', () => {
      const e = exportOf('BE-3', 'be-3-values', [{ body: '{"ts_value": 777777.777' }]);
      try {
        synthesizeFromExport({ ...e, spec: 'be-3-values', name: 'test' });
        expect.unreachable();
      } catch (err) {
        expect((err as Refusal).code).toBe(1);
        expect((err as Refusal).message).not.toContain('777777');
      }
    });
  });
});
