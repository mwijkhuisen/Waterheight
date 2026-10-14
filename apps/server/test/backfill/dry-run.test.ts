import { readdirSync, readFileSync } from 'node:fs';
import { constants as zc, zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKFILL_USAGE, backfillMain, parseBackfillArgs } from '../../src/backfill/cli.ts';
import { BYTES_PER_VALUE, DB_BYTES_PER_ROW, project, ZSTD_RATIO } from '../../src/backfill/project.ts';
import { config, SPEC } from './harness.ts';

// `backfill plan --dry-run` uses no database and no network (plan §3.3), and its constants are pinned against the
// real NL-1 fixtures.

const spec = config.specs.find((s) => s.id === SPEC);
if (spec === undefined) throw new Error('no spec');

afterEach(() => vi.restoreAllMocks());

async function dry(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((l: string) => void out.push(l));
  // An unreachable database URL: a dry run must not even read it.
  const code = await backfillMain(
    ['plan', ...argv, '--dry-run'],
    { DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' },
    (l) => err.push(l),
  );
  return { code, lines: out.map((l) => JSON.parse(l)), err };
}

describe('constants against the real fixtures', () => {
  const FIXTURES = new URL('../../src/adapters/nl-1/fixtures/', import.meta.url);
  const names = readdirSync(FIXTURES).filter((f) => /^nl-1-obs-.*\.raw$/.test(f) && !f.includes('synthetic'));
  let values = 0;
  let bytes = 0;
  let compressed = 0;
  for (const f of names) {
    const text = readFileSync(new URL(f, FIXTURES), 'utf8');
    if (text.length < 5) continue; // an empty-payload fixture
    for (const list of JSON.parse(text).WaarnemingenLijst as { MetingenLijst: unknown[] }[]) {
      const json = JSON.stringify(list.MetingenLijst);
      values += list.MetingenLijst.length;
      bytes += json.length;
      compressed += zstdCompressSync(Buffer.from(json), { params: { [zc.ZSTD_c_compressionLevel]: 9 } }).length;
    }
  }

  it('reads real fixtures', () => {
    expect(values).toBeGreaterThan(100);
  });
  it('BYTES_PER_VALUE is within 25 % of the fixtures', () => {
    const measured = bytes / values;
    expect(BYTES_PER_VALUE).toBeGreaterThan(measured * 0.75);
    expect(BYTES_PER_VALUE).toBeLessThan(measured * 1.25);
  });
  it('ZSTD_RATIO is within 25 % of the fixtures', () => {
    const measured = bytes / compressed;
    expect(ZSTD_RATIO).toBeGreaterThan(measured * 0.75);
    expect(ZSTD_RATIO).toBeLessThan(measured * 1.25);
  });
  it('DB_BYTES_PER_ROW is a heap row plus its key', () => {
    expect(DB_BYTES_PER_ROW).toBe(90);
  });
});

describe('plan --dry-run', () => {
  it('prints one line per series and a totals line, from the registry alone', async () => {
    const r = await dry('--spec', SPEC);
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    const rows = r.lines.slice(0, -1);
    const totals = r.lines.at(-1).totals;
    expect(rows).toHaveLength(spec.series.length);
    expect(rows.map((x) => x.series)).toEqual(spec.series.map((s) => s.series_key));
    for (const row of rows) {
      expect(Object.keys(row)).toEqual([
        'series',
        'chunks',
        'requests',
        'values',
        'bytes',
        'db_bytes',
        'archive_bytes',
      ]);
      // 1990-01-01 .. 2026-10-02 (DATA_EPOCH) in 40-day chunks, plus one probe per calendar year (1990 … 2026).
      expect(row.chunks).toBe(336);
      expect(row.requests).toBe(336 + 37);
      expect(row.bytes).toBe(row.values * BYTES_PER_VALUE);
      expect(row.db_bytes).toBe(row.values * DB_BYTES_PER_ROW);
      expect(row.archive_bytes).toBe(Math.ceil(row.bytes / ZSTD_RATIO));
    }
    expect(totals).toMatchObject({
      spec: SPEC,
      from: '1990-01-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      series: rows.length,
    });
    for (const k of ['chunks', 'requests', 'values', 'bytes', 'db_bytes', 'archive_bytes'])
      expect(totals[k], k).toBe(rows.reduce((a: number, x: Record<string, number>) => a + (x[k] as number), 0));
    // At 1 request a second.
    expect(totals.hours_at_pace).toBeCloseTo((totals.requests * 1000) / 3_600_000, 0);
  });

  it('takes a range and a series list', async () => {
    const key = spec.series[0]?.series_key as string;
    const r = await dry('--spec', SPEC, '--from', '2020-01-01', '--to', '2020-03-01', '--series', key);
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(2);
    // 60 days: 40 + 20; one calendar year to probe.
    expect(r.lines[0]).toMatchObject({ series: key, chunks: 2, requests: 3 });
    expect(r.lines[1].totals).toMatchObject({
      from: '2020-01-01T00:00:00.000Z',
      to: '2020-03-01T00:00:00.000Z',
      series: 1,
    });
  });

  it('refuses a range before the floor or past the data epoch, an inverted range, a series the spec does not select, an unknown spec', async () => {
    for (const argv of [
      ['--spec', SPEC, '--from', '1989-12-31'],
      ['--spec', SPEC, '--to', '2026-10-03'],
      ['--spec', SPEC, '--from', '2020-01-01', '--to', '2019-01-01'],
      ['--spec', SPEC, '--series', 'eijsden.grens/WATHTE/TAW/other:F007'],
      ['--spec', 'nope'],
    ]) {
      const r = await dry(...argv);
      expect(r.code, argv.join(' ')).toBe(64);
      expect(r.lines).toEqual([]);
    }
  }, 30_000);

  it('projects a series from its native step', () => {
    const s = { ...(spec.series[0] as (typeof spec.series)[number]), step_ms: 3_600_000 };
    const p = project(s, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-11T00:00:00Z'), spec.chunk_ms);
    expect(p).toMatchObject({ chunks: 1, requests: 2, values: 240 });
  });
});

describe('arguments', () => {
  it('accepts the documented forms', () => {
    expect(parseBackfillArgs(['plan', '--spec', SPEC, '--dry-run'])).toMatchObject({
      cmd: 'plan',
      dryRun: true,
      from: null,
    });
    expect(parseBackfillArgs(['run'])).toEqual({ cmd: 'run', until: null });
    expect(parseBackfillArgs(['run', '--until', '2026-10-14T03:00:00Z'])).toEqual({
      cmd: 'run',
      until: new Date('2026-10-14T03:00:00Z'),
    });
    expect(parseBackfillArgs(['status'])).toEqual({ cmd: 'status' });
    for (const cmd of ['pause', 'resume', 'abort'] as const)
      expect(parseBackfillArgs([cmd, '--job', '12'])).toEqual({ cmd, job: 12 });
  });
  it('refuses everything else with a usage text', () => {
    for (const argv of [
      [],
      ['plan'],
      ['plan', '--spec', 'NL 1'],
      ['plan', '--spec', SPEC, '--from', '2020-13-01'],
      ['plan', '--spec', SPEC, '--spec', SPEC],
      ['plan', '--spec', SPEC, '--series', 'a b'],
      ['run', '--until', '2026-10-14'],
      ['run', '--dry-run'],
      ['status', 'x'],
      ['pause'],
      ['pause', '--job', '0'],
      ['abort', '--job', 'x'],
      ['frobnicate'],
    ])
      expect(typeof parseBackfillArgs(argv), argv.join(' ')).toBe('string');
    expect(parseBackfillArgs(['frobnicate'])).toBe(BACKFILL_USAGE);
  });
});
