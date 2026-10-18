import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { constants as zc, zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { backfillMain } from '../../src/backfill/cli.ts';
import { DB_BYTES_PER_ROW, project } from '../../src/backfill/project.ts';
import { PROVIDERS } from '../../src/backfill/provider.ts';
import { config } from './harness.ts';

// P14b (plan §3.3, §4 "Dry-run"): `backfill plan --dry-run` of the three committed open-archive specs, through the
// CLI's own function (no database, no network). Their DB projection together stays at or under 3 GB (A§11.4, beside
// NL-1's ~7 GB), and each provider's dry-run constants are within ±25 % of what its recordings measure. The per-spec
// projection is printed for the PR.

const SPECS = ['de-8-backfill-w', 'fr-2-backfill-elab', 'ch-9-backfill-bs'] as const;
const SOURCE = { 'de-8-backfill-w': 'DE-8', 'fr-2-backfill-elab': 'FR-2', 'ch-9-backfill-bs': 'CH-9' } as const;
const ZSTD_LEVEL = 9; // the archive's (archive/writer.ts)

afterEach(() => vi.restoreAllMocks());

type Row = { series: string; chunks: number; requests: number; values: number; bytes: number; db_bytes: number };
type Totals = { [k: string]: unknown } & Omit<Row, 'series'> & { series: number };

async function dry(spec: string): Promise<{ code: number; rows: Row[]; totals: Totals; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((l: string) => void out.push(l));
  // An unreachable database URL: a dry run must not even read it.
  const code = await backfillMain(
    ['plan', '--spec', spec, '--dry-run'],
    { DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' },
    (l) => err.push(l),
  );
  vi.restoreAllMocks();
  const lines = out.map((l) => JSON.parse(l));
  return { code, rows: lines.slice(0, -1), totals: lines.at(-1)?.totals, err };
}

const fixtures = (id: string) => new URL(`../../src/adapters/${id}/fixtures/`, import.meta.url);
/** The real (not synthetic) fixtures of a spec: body and meta. */
function realFixtures(id: string, spec: string) {
  const dir = fixtures(id);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.raw') && !f.includes('synthetic'))
    .map((f) => ({
      name: f,
      body: readFileSync(new URL(f, dir)),
      meta: JSON.parse(readFileSync(new URL(f.replace(/\.raw$/, '.meta.json'), dir), 'utf8')),
    }))
    .filter((f) => f.meta.spec === spec && f.meta.synthetic === false);
}
const zstd = (b: Buffer) => zstdCompressSync(b, { params: { [zc.ZSTD_c_compressionLevel]: ZSTD_LEVEL } }).length;
const within = (constant: number, measured: number, what: string) => {
  expect(constant, `${what}: ${constant} vs measured ${measured.toFixed(2)}`).toBeGreaterThanOrEqual(measured * 0.75);
  expect(constant, `${what}: ${constant} vs measured ${measured.toFixed(2)}`).toBeLessThanOrEqual(measured * 1.25);
};

describe('plan --dry-run of the committed open-archive specs', () => {
  it('projects each spec from the registry alone, and at most 3 GB of DB together', async () => {
    let db = 0;
    const report: Record<string, unknown>[] = [];
    for (const spec of SPECS) {
      const r = await dry(spec);
      expect(r.code, spec).toBe(0);
      expect(r.err, spec).toEqual([]);
      const loaded = config.specs.find((s) => s.id === spec);
      expect(loaded?.source).toBe(SOURCE[spec]);
      // One line per unit that meets the range, and the totals add them up.
      expect(r.rows.length, spec).toBe(r.totals.series);
      expect(r.rows.length, spec).toBeGreaterThan(0);
      for (const k of ['chunks', 'requests', 'values', 'bytes', 'db_bytes'] as const)
        expect(r.totals[k], `${spec} ${k}`).toBe(r.rows.reduce((a, x) => a + x[k], 0));
      // Every spec with a target stops at DATA_FLOOR.
      expect(r.totals).toMatchObject({ spec, to: '2026-08-01T00:00:00.000Z' });
      db += r.totals.db_bytes;
      report.push({ ...r.totals });
    }
    console.info(`P14b dry-run projection:\n${report.map((t) => JSON.stringify(t)).join('\n')}`);
    console.info(`P14b dry-run DB total: ${db} bytes (${(db / 1e9).toFixed(3)} GB of 3 GB)`);
    expect(db).toBeGreaterThan(0);
    expect(db).toBeLessThanOrEqual(3e9);
  });

  it('DE-8: one request per decade file (reuse), 32 files of the four catchments, the ZIP note', async () => {
    const r = await dry('de-8-backfill-w');
    expect(r.rows).toHaveLength(32);
    for (const row of r.rows) expect(row.requests, row.series).toBe(1);
    expect(r.totals).toMatchObject({ requests: 32, zstd_ratio: 1, note: expect.stringMatching(/ZIP/) });
  });

  it('FR-2: one job per aggregate twin series of FR-1 (71), no probe', async () => {
    const r = await dry('fr-2-backfill-elab');
    expect(r.rows).toHaveLength(71);
    for (const row of r.rows) expect(row.requests, row.series).toBe(row.chunks);
  });

  it('CH-9: one job per dataset, no probe', async () => {
    const r = await dry('ch-9-backfill-bs');
    expect(r.rows.map((x) => x.series)).toEqual(['100089', '100236']);
    for (const row of r.rows) expect(row.requests, row.series).toBe(row.chunks);
  });
});

describe('dry-run constants against the recordings (±25 %)', () => {
  it('every provider counts a stored row as P14a does: an obs heap row plus its key', () => {
    for (const s of ['DE-8', 'FR-2', 'CH-9']) expect(PROVIDERS[s]?.dryRun?.db_bytes_per_row, s).toBe(DB_BYTES_PER_ROW);
  });

  it('FR-2: bytes per record and the zstd ratio of the real obs_elab answers', () => {
    const real = realFixtures('fr-2', 'fr-2-backfill-elab');
    let records = 0;
    let bytes = 0;
    let compressed = 0;
    for (const f of real) {
      const n = (JSON.parse(f.body.toString('utf8')).data as unknown[]).length;
      if (n < 100) continue; // the empty answer and the 3-record page measure the envelope, not a record
      records += n;
      bytes += f.body.length;
      compressed += zstd(f.body);
    }
    expect(records).toBeGreaterThan(500);
    const c = PROVIDERS['FR-2']?.dryRun;
    within(c?.bytes_per_value ?? 0, bytes / records, 'FR-2 bytes_per_value');
    within(c?.zstd_ratio ?? 0, bytes / compressed, 'FR-2 zstd_ratio');
    // The untrimmed sizes the metas state agree: 2,677,719 B for 7,018 records (Uckange QmnJ 1981-2000).
    const uckange = real.find((f) => f.name === 'fr-2-elab-uckange-qmnj-1981.raw');
    within(c?.bytes_per_value ?? 0, (uckange?.meta.bytes ?? 0) / 7018, 'FR-2 bytes_per_value (untrimmed)');
  });

  it('CH-9: bytes per value (two a record: W and Q) and the zstd ratio of the real exports', () => {
    const real = realFixtures('ch-9', 'ch-9-backfill-bs');
    let values = 0;
    let bytes = 0;
    let compressed = 0;
    for (const f of real) {
      values += 2 * (JSON.parse(f.body.toString('utf8')) as unknown[]).length;
      bytes += f.body.length;
      compressed += zstd(f.body);
    }
    expect(values).toBeGreaterThan(1000);
    const c = PROVIDERS['CH-9']?.dryRun;
    within(c?.bytes_per_value ?? 0, bytes / values, 'CH-9 bytes_per_value');
    within(c?.zstd_ratio ?? 0, bytes / compressed, 'CH-9 zstd_ratio');
  });

  // A constant is only as good as the `values` it is multiplied by: the projection of one recorded answer's span
  // must give that answer's bytes and the rows it stores, within ±25 % (what the owner sizes `--from` with).
  const unitOf = (id: string, key: string) => {
    const s = config.specs.find((x) => x.id === id);
    const u = (s?.series as readonly { series_key: string }[] | undefined)?.find((x) => x.series_key === key);
    if (s === undefined || u === undefined) throw new Error(`${id} ${key}`);
    return { spec: s, unit: u as (typeof s.series)[number] };
  };

  it('FR-2: the projection of a recorded answer is its bytes and its rows (one a day)', () => {
    const { spec, unit } = unitOf('fr-2-backfill-elab', 'A850061001/QmnJ');
    // fr-2-uckange-qmnj-1981 asked 1981-01-01 .. 2000-12-31 and stated 7,018 days (from 1981-10-02) in 2,677,719 B.
    const p = project(
      unit,
      new Date('1981-10-02T00:00:00Z'),
      new Date('2001-01-01T00:00:00Z'),
      spec.chunk_ms,
      PROVIDERS['FR-2'],
    );
    within(p.bytes, 2_677_719, 'FR-2 projected bytes of the Uckange 1981-2000 answer');
    within(p.db_bytes / DB_BYTES_PER_ROW, 7018, 'FR-2 projected rows of the Uckange 1981-2000 answer');
  });

  it.each([
    ['100089', 2],
    ['100236', 1],
  ] as const)(
    'CH-9 %s: the projection of a P30D export is its bytes and its rows (%i per 10-minute instant)',
    (id, slots) => {
      const { spec, unit } = unitOf('ch-9-backfill-bs', id);
      const f = realFixtures('ch-9', 'ch-9-backfill-bs').find((x) => x.meta.variant === id && x.body.length > 20_000);
      const records = JSON.parse(f?.body.toString('utf8') ?? '[]') as { timestamp: string }[];
      expect(records.length).toBeGreaterThan(200);
      // The recording's own density (5-minute records) and size per record, over a P30D chunk.
      const span = Date.parse(records.at(-1)?.timestamp ?? '') - Date.parse(records[0]?.timestamp ?? '');
      const perMs = (records.length - 1) / span;
      const from = new Date('2026-06-01T00:00:00Z');
      const to = new Date(from.getTime() + spec.chunk_ms);
      const answered = perMs * spec.chunk_ms;
      const p = project(unit, from, to, spec.chunk_ms, PROVIDERS['CH-9']);
      within(
        p.bytes,
        answered * ((f?.body.length ?? 0) / records.length),
        `CH-9 ${id} projected bytes of a P30D export`,
      );
      // The rows it stores: the records on the 10-minute grid (half of them), W and, for 100089, Q.
      within(p.db_bytes / DB_BYTES_PER_ROW, (spec.chunk_ms / 600_000) * slots, `CH-9 ${id} projected rows of P30D`);
    },
  );

  // DE-8's constant is file bytes per grid point of a selected gauge, a mean over the spec's 32 decade files (the
  // dataset sets how many members share a file): no single decade file measures it (Rur 2020 holds 27 members for 1
  // selected gauge, IBV 1950 5 selected gauges with change-driven stamps). The recorded hydro/w index states every
  // file's size; the committed fixtures must agree with it.
  const INDEX = new URL('de-8-w-index.raw', fixtures('de-8'));
  const IndexFile = z.looseObject({
    datasets: z.array(
      z.looseObject({ name: z.string(), files: z.array(z.looseObject({ name: z.string(), size: z.string() })) }),
    ),
  });

  it('DE-8: bytes per selected grid point over the spec, from the recorded hydro/w index', async () => {
    expect(
      existsSync(INDEX),
      'the recorded hydro/w index (de-8-w-index.raw) must be a committed DE-8 fixture to pin the DE-8 constant',
    ).toBe(true);
    const index = IndexFile.parse(JSON.parse(readFileSync(INDEX, 'utf8')));
    const sizes = new Map(index.datasets.flatMap((d) => d.files.map((f) => [f.name, Number(f.size)] as const)));
    const spec = config.specs.find((s) => s.id === 'de-8-backfill-w');
    if (spec?.source !== 'DE-8') throw new Error('no DE-8 spec');
    let bytes = 0;
    let values = 0;
    for (const u of spec.series) {
      const size = sizes.get(u.file);
      expect(size, `${u.file} is in the index`).toBeGreaterThan(0);
      bytes += size ?? 0;
      values += u.values ?? 0;
    }
    within(PROVIDERS['DE-8']?.dryRun?.bytes_per_value ?? 0, bytes / values, 'DE-8 bytes_per_value');
    // The dry-run's bytes (pro rata to DATA_FLOOR for the 2020s) are the files' within ±25 % too.
    within((await dry('de-8-backfill-w')).totals.bytes, bytes, 'DE-8 projected bytes vs the 32 files');
    // The committed whole-file metas name the size the index states.
    // (The W index lists the hydro/w files only; the Q error fixture is a hydro/q file.)
    for (const f of realFixtures('de-8', 'de-8-backfill-w').filter((x) => String(x.meta.url).includes('/hydro/w/'))) {
      const name = String(f.meta.url).split('/').at(-1) as string;
      expect(f.meta.bytes, name).toBe(sizes.get(name));
    }
  });
});
