import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { ValiditySpec } from '../../src/archive/validity.ts';
import { plan, planRange } from '../../src/backfill/cli.ts';
import { LEASE_MS } from '../../src/backfill/job.ts';
import { jobBudget, planChunks, unitRange } from '../../src/backfill/plan.ts';
import { NL1_DRY_RUN, project } from '../../src/backfill/project.ts';
import { PROVIDERS, type Provider } from '../../src/backfill/provider.ts';
import { runBackfill } from '../../src/backfill/run.ts';
import {
  BackfillSpec,
  ceilingMs,
  type LoadedBackfill,
  type LoadedBackfillSpec,
  loadBackfill,
  type Unit,
} from '../../src/backfill/spec.ts';
import { DATA_EPOCH, DATA_FLOOR } from '../../src/load/dirty.ts';
import { type Answer, Clock, config, fakeClient, MemoryJobStore, nl1Spec, registry, tempArchive } from './harness.ts';

// P14b: the runner, planner and dry-run for the open archives (DE-8, FR-2, CH-9), on fake providers and an in-memory
// store, so that nothing here depends on the provider files being built. The spec union and loadBackfill's checks
// run against the real registry (and copies of it).

const raw = parse(readFileSync(new URL('../../../../registry/backfill.yaml', import.meta.url), 'utf8')) as {
  specs: Record<string, unknown>[];
};
const rawSpec = (id: string) => {
  const s = raw.specs.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no ${id}`);
  return s;
};

describe('the spec union', () => {
  it('every committed spec parses as its own member, and the NL-1 one is unchanged', () => {
    for (const s of raw.specs) expect(BackfillSpec.safeParse(s).success, String(s.id)).toBe(true);
    expect(raw.specs.map((s) => [s.id, s.source, s.target])).toEqual([
      ['nl-1-backfill-obs', 'NL-1', undefined],
      ['de-8-backfill-w', 'DE-8', 'DE-7'],
      ['fr-2-backfill-elab', 'FR-2', 'FR-1'],
      ['ch-9-backfill-bs', 'CH-9', 'CH-1'],
    ]);
    expect(rawSpec('nl-1-backfill-obs')).toEqual({
      id: 'nl-1-backfill-obs',
      source: 'NL-1',
      version: 1,
      url: 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen',
      check_url:
        'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/CheckWaarnemingenAanwezig',
      select: { first_release: true, quantities: ['WATHTE', 'Q'], role: 'primary' },
      chunk: 'P40D',
      floor: '1990-01-01',
      max_bytes: 4194304,
      retention: 'backfill',
    });
  });

  it('a member is strict: an unknown source, a wrong or missing target, NL-1 with a target, a check_url elsewhere', () => {
    const de8 = rawSpec('de-8-backfill-w');
    const fr2 = rawSpec('fr-2-backfill-elab');
    for (const bad of [
      { ...de8, source: 'DE-9' },
      { ...de8, target: 'DE-1' },
      (({ target: _, ...rest }) => rest)(de8),
      { ...rawSpec('nl-1-backfill-obs'), target: 'NL-1' },
      { ...fr2, check_url: 'https://hubeau.eaufrance.fr/x' },
      { ...fr2, chunk: 'P10000D' },
      { ...fr2, max_bytes: 129 * 1024 * 1024 },
      { ...rawSpec('ch-9-backfill-bs'), datasets: [{ id: '1000', station: '2289' }] },
    ])
      expect(BackfillSpec.safeParse(bad).success).toBe(false);
  });

  it('the caps rule: max_bytes above 25 MiB needs caps with a justification', () => {
    const fr2 = rawSpec('fr-2-backfill-elab');
    const big = { ...fr2, max_bytes: 26 * 1024 * 1024 };
    expect(BackfillSpec.safeParse(big).success).toBe(false);
    expect(BackfillSpec.safeParse({ ...big, caps: { justification: 'too short' } }).success).toBe(false);
    expect(
      BackfillSpec.safeParse({ ...big, caps: { justification: 'measured on the recording fr-2-x: 26 MB' } }).success,
    ).toBe(true);
    expect(BackfillSpec.safeParse({ ...fr2, max_bytes: 25 * 1024 * 1024 }).success).toBe(true);
    // The committed DE-8 caps carry their measurement.
    expect((rawSpec('de-8-backfill-w').caps as { justification: string }).justification).toMatch(/292 MB/);
  });

  it('the ceiling is DATA_EPOCH for NL-1 and DATA_FLOOR for a spec with a target', () => {
    expect(ceilingMs({})).toBe(Date.parse(DATA_EPOCH));
    expect(ceilingMs({ target: 'DE-7' })).toBe(Date.parse(DATA_FLOOR));
  });
});

/** A copy of the registry with some files' text changed. */
const REGISTRY = new URL('../../../../registry/', import.meta.url);
function copy(changes: Record<string, (text: string) => string>): URL {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-registry-'));
  cpSync(REGISTRY, dir, { recursive: true });
  for (const [file, change] of Object.entries(changes))
    writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
  return pathToFileURL(`${dir}/`);
}
/** One source's block of sources.yaml with one key changed. */
const source = (id: string, key: string, value: string) => (text: string) => {
  const at = text.indexOf(`  - id: ${id}\n`);
  const end = text.indexOf('\n  - id: ', at + 1);
  return (
    text.slice(0, at) +
    text.slice(at, end).replace(new RegExp(`\\n    ${key}: .*`), `\n    ${key}: ${value}`) +
    text.slice(end)
  );
};

const UNIT = (key: string, range?: { from: string; to: string }, values?: number): Unit => ({
  series_key: key,
  step_ms: 900_000,
  ...(range === undefined ? {} : { range: { from: new Date(range.from), to: new Date(range.to) } }),
  ...(values === undefined ? {} : { values }),
});
const VALIDITY: ValiditySpec = {
  format: 'json',
  required: [],
  reject: [],
  count: 'data',
  min: 0,
  allow_status: [204],
  end_html: false,
};
/** A provider with no probe: one GET per unit and chunk, a JSON body `{"data": [...]}`. */
function fakeProvider(o: Partial<Provider> = {}): Provider {
  return {
    units: () => [UNIT('a/2020', { from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' })],
    chunkRequest: (_spec, unit, chunk) => ({
      url: `https://archive.example/${unit.series_key}?from=${encodeURIComponent(chunk.from.toISOString())}&to=${encodeURIComponent(chunk.to.toISOString())}`,
      method: 'GET',
      variant: unit.series_key,
    }),
    inspect: (body) => {
      const doc = JSON.parse(Buffer.from(body).toString('utf8'));
      return doc.next === undefined ? { ok: true, values: doc.data.length } : { ok: false, code: 'truncated' };
    },
    validity: VALIDITY,
    ...o,
  };
}

describe('loadBackfill', () => {
  /** The real NL-1 provider and fakes for the three new sources (whatever their files hold now). */
  const fakes = (o: Record<string, Provider | undefined> = {}) => {
    const map: Record<string, Provider> = { 'NL-1': PROVIDERS['NL-1'] as Provider };
    for (const s of ['DE-8', 'FR-2', 'CH-9']) {
      const p = s in o ? o[s] : fakeProvider();
      if (p !== undefined) map[s] = p;
    }
    return map;
  };

  it('loads every spec with its host limits, chunk and target, and the units of its provider', () => {
    const c = loadBackfill(registry.hosts, undefined, fakes());
    expect(c.skipped).toBeUndefined();
    expect(c.specs.map((s) => [s.id, s.host, s.target, s.chunk_ms / 86_400_000])).toEqual([
      ['nl-1-backfill-obs', 'ddapi20-waterwebservices.rijkswaterstaat.nl', undefined, 40],
      ['de-8-backfill-w', 'www.opengeodata.nrw.de', 'DE-7', 30],
      ['fr-2-backfill-elab', 'hubeau.eaufrance.fr', 'FR-1', 7300],
      ['ch-9-backfill-bs', 'data.bs.ch', 'CH-1', 30],
    ]);
    expect(c.specs[1]?.series.map((u) => u.series_key)).toEqual(['a/2020']);
    expect(c.hosts['www.opengeodata.nrw.de']).toEqual({
      min_interval_ms: 30000,
      max_per_hour: 20,
      window_utc: { from: '22:00', to: '05:00' },
    });
  });

  it('a source whose provider is not built is left out and named, never a crash', () => {
    const c = loadBackfill(registry.hosts, undefined, fakes({ 'DE-8': undefined }));
    expect(c.specs.map((s) => s.id)).not.toContain('de-8-backfill-w');
    expect(c.skipped).toEqual(['backfill spec de-8-backfill-w: no provider for DE-8']);
  });

  it('a registry fault the provider finds is a problem of the file', () => {
    const units = () => {
      throw new Error('registry/stations: 1/W is not public like its source');
    };
    expect(() => loadBackfill(registry.hosts, undefined, fakes({ 'CH-9': fakeProvider({ units }) }))).toThrow(
      /ch-9-backfill-bs: registry\/stations: 1\/W is not public/,
    );
  });

  it('refuses a target that is not public or has history_export off, and a host outside the allowlist', () => {
    expect(() =>
      loadBackfill(registry.hosts, copy({ 'sources.yaml': source('DE-7', 'audience', 'owner') }), fakes()),
    ).toThrow(/de-8-backfill-w: target DE-7 is not a public source/);
    expect(() =>
      loadBackfill(registry.hosts, copy({ 'sources.yaml': source('FR-1', 'history_export', 'false') }), fakes()),
    ).toThrow(/fr-2-backfill-elab: target FR-1 has history_export off/);
    expect(() =>
      loadBackfill(registry.hosts, copy({ 'sources.yaml': source('CH-9', 'history_export', 'false') }), fakes()),
    ).toThrow(/ch-9-backfill-bs: CH-9 has history_export off/);
    const hosts = new Map(registry.hosts);
    hosts.set('CH-9', ['example.org']);
    expect(() => loadBackfill(hosts, undefined, fakes())).toThrow(/host data\.bs\.ch is not allowlisted for CH-9/);
  });

  it('refuses a floor at or after the ceiling', () => {
    const dir = copy({ 'backfill.yaml': (t) => t.replace('floor: "2020-06-01"', 'floor: "2026-08-01"') });
    expect(() => loadBackfill(registry.hosts, dir, fakes())).toThrow(/ch-9-backfill-bs: floor is not before/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The runner.

const HOST = 'archive.example';
const LIMITS = { min_interval_ms: 1000, max_per_hour: 3600, window_utc: { from: '22:00', to: '05:00' } };

/** A DE-8-shaped loaded spec on fake units; `chunkDays` per chunk. */
function spec(units: Unit[], chunkDays = 30, source = 'DE-8'): LoadedBackfillSpec {
  return {
    id: 'fake-backfill',
    source,
    target: 'DE-7',
    version: 1,
    url: `https://${HOST}/`,
    select: { first_release: true },
    chunk: `P${chunkDays}D`,
    floor: '1950-01-01',
    max_bytes: 1 << 20,
    retention: 'backfill',
    datasets: [],
    host: HOST,
    limits: LIMITS,
    chunk_ms: chunkDays * 86_400_000,
    series: units,
  } as unknown as LoadedBackfillSpec;
}
const configOf = (s: LoadedBackfillSpec): LoadedBackfill => ({ specs: [s], hosts: { [HOST]: LIMITS } });

async function job(store: MemoryJobStore, s: LoadedBackfillSpec, key: string, from: string, to: string, probe = false) {
  const a = new Date(from);
  const b = new Date(to);
  const { id } = await store.insert({
    spec_id: s.id,
    source_id: s.source,
    series_key: key,
    range_from: a,
    range_to: b,
    chunk_ms: s.chunk_ms,
    request_budget: jobBudget(a, b, s.chunk_ms, probe),
  });
  return id;
}

const body = (o: object) => Buffer.from(JSON.stringify(o));
const DATA = body({ data: [1, 2, 3] });

function go(
  s: LoadedBackfillSpec,
  provider: Provider,
  store: MemoryJobStore,
  clock: Clock,
  answer: (call: { url: string }, n: number) => Answer,
  o: {
    hooks?: Parameters<typeof runBackfill>[0]['hooks'];
    holder?: string;
    archive?: ReturnType<typeof tempArchive>;
  } = {},
) {
  const { client, calls } = fakeClient(clock, answer);
  const t = o.archive ?? tempArchive();
  const run = runBackfill({
    config: configOf(s),
    store,
    archive: t.archive,
    client,
    now: clock.now,
    sleep: clock.sleep,
    providers: { [s.source]: provider },
    ...(o.hooks === undefined ? {} : { hooks: o.hooks }),
    ...(o.holder === undefined ? {} : { holder: o.holder }),
  });
  return { run, calls, t };
}

describe('a provider without a probe', () => {
  it('asks the first chunk at once; data_from stays null; the guard gets source and target', async () => {
    const s = spec([UNIT('a/2020', { from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' })]);
    const store = new MemoryJobStore();
    const guards: unknown[][] = [];
    store.guard = async (...a: unknown[]) => {
      guards.push(a);
      return 'ok';
    };
    const id = await job(store, s, 'a/2020', '2020-01-01T00:00:00Z', '2020-03-01T00:00:00Z');
    const clock = new Clock();
    const { run, calls, t } = go(s, fakeProvider(), store, clock, () => ({ status: 200, body: DATA }));
    expect((await run).stopped).toBe('done');
    expect(calls.map((c) => new URL(c.url).searchParams.get('from'))).toEqual([
      '2020-01-01T00:00:00.000Z',
      '2020-01-31T00:00:00.000Z',
    ]);
    expect(await store.get(id)).toMatchObject({ status: 'done', chunks_done: 2, requests: 2, data_from: null });
    expect(t.lines().map((l) => l.variant)).toEqual(['', '']);
    expect(guards[0]).toEqual(['DE-8', 'DE-7']);
  });

  it('an NL-1 job still passes the guard its source alone', async () => {
    const s = nl1Spec();
    const store = new MemoryJobStore();
    const guards: unknown[][] = [];
    store.guard = async (...a: unknown[]) => {
      guards.push(a);
      return 'stale';
    };
    const series = s.series[0];
    if (series === undefined) throw new Error('no series');
    await store.insert({
      spec_id: s.id,
      source_id: 'NL-1',
      series_key: series.series_key,
      range_from: new Date('2026-05-01T00:00:00Z'),
      range_to: new Date('2026-06-01T00:00:00Z'),
      chunk_ms: s.chunk_ms,
      request_budget: 3,
    });
    const clock = new Clock();
    const { client } = fakeClient(clock, () => ({ status: 200 }));
    await runBackfill(
      {
        config: { specs: [s], hosts: {} },
        store,
        archive: tempArchive().archive,
        client,
        now: clock.now,
        sleep: clock.sleep,
      },
      { until: new Date(clock.t + 60_000) },
    );
    expect(guards[0]).toEqual(['NL-1', undefined]);
  });

  it('invalid_job: a range past DATA_FLOOR for a spec with a target, outside its unit, or a budget with probe years', async () => {
    const s = spec([UNIT('a/2020', { from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' })]);
    for (const [from, to, extra] of [
      ['2026-07-01T00:00:00Z', '2026-08-02T00:00:00Z', 0],
      ['2019-12-01T00:00:00Z', '2020-02-01T00:00:00Z', 0],
      ['2020-01-01T00:00:00Z', '2020-03-01T00:00:00Z', 1],
    ] as const) {
      const store = new MemoryJobStore();
      const id = await job(store, s, 'a/2020', from, to);
      const j = store.jobs.get(id);
      if (j !== undefined) j.request_budget += extra;
      const clock = new Clock();
      const { run, calls } = go(s, fakeProvider(), store, clock, () => ({ status: 200, body: DATA }));
      await run;
      expect(calls, `${from} ${to}`).toHaveLength(0);
      expect(await store.get(id)).toMatchObject({ status: 'failed', last_error: 'invalid_job' });
    }
  });
});

describe('okStatus (FR-2: 206)', () => {
  const s = spec([UNIT('A1/QmnJ')], 10, 'FR-2');
  /** Two 10-day chunks: a budget of 3 requests. */
  const range = ['2000-01-01T00:00:00Z', '2000-01-21T00:00:00Z'] as const;

  it('a 206 is validated and inspected like a 200: truncated halves the chunk, a whole one commits with its status', async () => {
    const store = new MemoryJobStore();
    const id = await job(store, s, 'A1/QmnJ', ...range);
    const clock = new Clock();
    const provider = fakeProvider({ okStatus: [200, 204, 206] });
    const { run, calls, t } = go(s, provider, store, clock, (_c, n) =>
      n === 1 ? { status: 206, body: body({ data: [1], next: 'x' }) } : { status: 206, body: DATA },
    );
    expect((await run).stopped).toBe('done');
    expect(calls.map((c) => new URL(c.url).searchParams.get('to'))).toEqual([
      '2000-01-11T00:00:00.000Z',
      '2000-01-06T00:00:00.000Z',
      '2000-01-11T00:00:00.000Z',
    ]);
    expect(t.lines().map((l) => [l.status, l.backfill?.from, l.backfill?.to])).toEqual([
      [206, '2000-01-01T00:00:00.000Z', '2000-01-06T00:00:00.000Z'],
      [206, '2000-01-06T00:00:00.000Z', '2000-01-11T00:00:00.000Z'],
    ]);
    // The halved span is kept for the job (review N2), so its budget runs out: the owner re-plans from the cursor.
    expect(await store.get(id)).toMatchObject({ status: 'paused', last_error: 'budget', chunks_done: 2, requests: 3 });
  });

  it('without it a 206 is unexpected', async () => {
    const store = new MemoryJobStore();
    const id = await job(store, s, 'A1/QmnJ', ...range);
    const { run } = go(s, fakeProvider(), store, new Clock(), () => ({ status: 206, body: DATA }));
    await run;
    expect(await store.get(id)).toMatchObject({ status: 'failed', last_error: 'unexpected_status' });
  });
});

describe('halvable: false (DE-8: a file is a file)', () => {
  const s = spec([UNIT('a/2020', { from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' })]);
  for (const [name, answer] of [
    ['a truncated answer', { status: 200, body: body({ data: [], next: 'x' }) }],
    ['too_large', { error: 'too_large' }],
  ] as const) {
    it(`${name} fails the job truncated at once, never halves`, async () => {
      const store = new MemoryJobStore();
      const id = await job(store, s, 'a/2020', '2020-01-01T00:00:00Z', '2020-03-01T00:00:00Z');
      const { run, calls } = go(s, fakeProvider({ halvable: false }), store, new Clock(), () => answer);
      await run;
      expect(calls).toHaveLength(1);
      expect(await store.get(id)).toMatchObject({ status: 'failed', last_error: 'truncated', chunks_done: 0 });
    });
  }
});

describe('reuse (DE-8: one decade file, many slices)', () => {
  const unit = UNIT('a/2020', { from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' });
  const s = spec([unit]);
  /** Every chunk asks the same file. */
  const file = fakeProvider({
    reuse: true,
    halvable: false,
    chunkRequest: (_spec, u) => ({ url: `https://${HOST}/${u.series_key}.zip`, method: 'GET', variant: u.series_key }),
  });
  const range = ['2020-01-01T00:00:00Z', '2020-04-01T00:00:00Z'] as const; // 91 days: four P30D slices

  it('sends one request for all chunks and commits each slice on the one key, with its own range', async () => {
    const store = new MemoryJobStore();
    const id = await job(store, s, 'a/2020', ...range);
    const clock = new Clock();
    const t = tempArchive();
    const puts: boolean[] = [];
    const archive = {
      ...t,
      archive: {
        put: async (...a: Parameters<typeof t.archive.put>) => {
          const r = await t.archive.put(...a);
          puts.push(r.created);
          return r;
        },
        append: (...a: Parameters<typeof t.archive.append>) => t.archive.append(...a),
      } as unknown as typeof t.archive,
    };
    const { run, calls } = go(s, file, store, clock, () => ({ status: 200, body: DATA }), { archive });
    expect((await run).stopped).toBe('done');
    expect(calls).toHaveLength(1);
    expect(await store.get(id)).toMatchObject({ status: 'done', chunks_done: 4, chunks_with_data: 4, requests: 1 });
    expect(puts).toEqual([true, false, false, false]);
    const lines = t.lines();
    expect(new Set(lines.map((l) => l.key)).size).toBe(1);
    expect(new Set(lines.map((l) => l.fetched_at.end)).size).toBe(1);
    expect(lines.map((l) => [l.backfill?.chunk, l.backfill?.from, l.backfill?.to])).toEqual([
      [0, '2020-01-01T00:00:00.000Z', '2020-01-31T00:00:00.000Z'],
      [1, '2020-01-31T00:00:00.000Z', '2020-03-01T00:00:00.000Z'],
      [2, '2020-03-01T00:00:00.000Z', '2020-03-31T00:00:00.000Z'],
      [3, '2020-03-31T00:00:00.000Z', '2020-04-01T00:00:00.000Z'],
    ]);
  });

  it('is not paced: the slices after the first wait for nothing (pacer)', async () => {
    const slow = spec([unit]);
    const limits = { ...LIMITS, min_interval_ms: 30_000 };
    const store = new MemoryJobStore();
    await job(store, slow, 'a/2020', ...range);
    const clock = new Clock();
    const start = clock.t;
    const { client, calls } = fakeClient(clock, () => ({ status: 200, body: DATA }));
    const out = await runBackfill({
      config: { specs: [{ ...slow, limits }], hosts: { [HOST]: limits } },
      store,
      archive: tempArchive().archive,
      client,
      now: clock.now,
      sleep: clock.sleep,
      providers: { 'DE-8': file },
    });
    expect(out.stopped).toBe('done');
    expect(calls).toHaveLength(1);
    expect(clock.t - start).toBeLessThan(limits.min_interval_ms);
  });

  it('renews the lease before every commit: past LEASE_MS of slices, a second runner is still busy', async () => {
    const clock = new Clock();
    /** Leases that lapse LEASE_MS after their last renewal, on the fake clock. */
    class LapsingStore extends MemoryJobStore {
      readonly until = new Map<string, number>();
      override async lease(host: string, holder: string) {
        const by = this.leases.get(host);
        if (by !== undefined && by !== holder && (this.until.get(host) ?? 0) > clock.t) return false;
        this.leases.set(host, holder);
        this.until.set(host, clock.t + LEASE_MS);
        return true;
      }
    }
    const store = new LapsingStore();
    const id = await job(store, s, 'a/2020', ...range);
    let second: string | undefined;
    const fetchedAt = clock.t;
    const { run, calls } = go(s, file, store, clock, () => ({ status: 200, body: DATA }), {
      holder: 'A',
      hooks: {
        // Each slice's commit takes 50 s of fake time (the loader, the disk): four slices outlive one lease.
        afterPut: async () => {
          clock.t += 50_000;
        },
        afterCursor: async () => {
          if (second !== undefined || clock.t - fetchedAt <= LEASE_MS) return;
          const b = go(s, file, store, clock, () => ({ status: 200, body: DATA }), { holder: 'B' });
          second = (await b.run).stopped;
          expect(b.calls).toHaveLength(0);
        },
      },
    });
    expect((await run).stopped).toBe('done');
    expect(second).toBe('busy');
    expect(calls).toHaveLength(1);
    expect(await store.get(id)).toMatchObject({ status: 'done', chunks_done: 4, requests: 1 });
  });

  it('a lease lost between two slices stops the run busy before the next commit', async () => {
    const store = new MemoryJobStore();
    const id = await job(store, s, 'a/2020', ...range);
    let n = 0;
    const { run } = go(s, file, store, new Clock(), () => ({ status: 200, body: DATA }), {
      holder: 'A',
      hooks: {
        afterCursor: async () => {
          if (++n === 2) store.leases.set(HOST, 'B');
        },
      },
    });
    expect((await run).stopped).toBe('busy');
    expect(await store.get(id)).toMatchObject({ chunks_done: 2, requests: 1 });
  });
});

describe('lineVariant (CH-9: the payload does not name its dataset)', () => {
  it("the manifest line's variant is the request's", async () => {
    const s = spec([UNIT('100089')], 30, 'CH-9');
    const store = new MemoryJobStore();
    await job(store, s, '100089', '2021-01-01T00:00:00Z', '2021-02-15T00:00:00Z');
    const { run, t } = go(s, fakeProvider({ lineVariant: true }), store, new Clock(), () => ({
      status: 200,
      body: DATA,
    }));
    expect((await run).stopped).toBe('done');
    expect(t.lines().map((l) => l.variant)).toEqual(['100089', '100089']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The planner and the dry-run.

describe('plan: one job per unit, cut to its range and the ceiling', () => {
  const units = [
    UNIT('a/1940', { from: '1940-01-01T00:00:00Z', to: '1950-01-01T00:00:00Z' }, 1000),
    UNIT('a/2010', { from: '2010-01-01T00:00:00Z', to: '2020-01-01T00:00:00Z' }, 350_000),
    UNIT('a/2020', { from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' }, 350_000),
  ];
  const s = spec(units);
  const provider = fakeProvider({ reuse: true, dryRun: { bytes_per_value: 4, zstd_ratio: 1, db_bytes_per_row: 90 } });
  afterEach(() => vi.restoreAllMocks());
  const args = (o: Partial<Parameters<typeof plan>[0]> = {}) => ({
    cmd: 'plan' as const,
    spec: s.id,
    from: null,
    to: null,
    series: null,
    dryRun: false,
    ...o,
  });

  it('unitRange intersects and an empty intersection is null', () => {
    const r = unitRange(units[2] as Unit, new Date('2024-01-01T00:00:00Z'), new Date(DATA_FLOOR));
    expect(r).toEqual({ from: new Date('2024-01-01T00:00:00Z'), to: new Date(DATA_FLOOR) });
    expect(unitRange(units[0] as Unit, new Date('1950-01-01T00:00:00Z'), new Date(DATA_FLOOR))).toBeNull();
    expect(unitRange(UNIT('x'), new Date(0), new Date(1))).toEqual({ from: new Date(0), to: new Date(1) });
  });

  it('a spec with a target defaults to and stops at DATA_FLOOR', () => {
    expect(planRange(s, null, null)).toEqual({ from: new Date('1950-01-01T00:00:00Z'), to: new Date(DATA_FLOOR) });
    expect(planRange(s, null, '2026-08-02')).toMatch(/after the data floor/);
    expect(planRange(nl1Spec(), null, null)).toMatchObject({ to: new Date(DATA_EPOCH) });
  });

  it('inserts a job per unit that meets the range, each with the budget of its own chunks and no probe years', async () => {
    const store = new MemoryJobStore();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await plan(args(), configOf(s), store, () => undefined, { 'DE-8': provider })).toBe(0);
    const jobs = await store.list();
    expect(jobs.map((j) => [j.series_key, j.range_from.toISOString(), j.range_to.toISOString()])).toEqual([
      ['a/2010', '2010-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'],
      ['a/2020', '2020-01-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
    ]);
    for (const j of jobs)
      expect(j.request_budget).toBe(Math.ceil(planChunks(j.range_from, j.range_to, s.chunk_ms).length * 1.2));
  });

  it('--series filters unit keys; a key the spec does not hold is a usage error', async () => {
    const store = new MemoryJobStore();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await plan(args({ series: ['a/2020'] }), configOf(s), store, () => undefined, { 'DE-8': provider })).toBe(0);
    expect((await store.list()).map((j) => j.series_key)).toEqual(['a/2020']);
    expect(await plan(args({ series: ['b/2020'] }), configOf(s), store, () => undefined, { 'DE-8': provider })).toBe(
      64,
    );
  });

  it('a spec without a built provider is a usage error that says so', async () => {
    const log: string[] = [];
    const c = { ...configOf(s), specs: [], skipped: [`backfill spec ${s.id}: no provider for DE-8`] };
    expect(await plan(args(), c, undefined, (l) => log.push(l), {})).toBe(64);
    expect(log).toEqual(['backfill plan: --spec has no provider built yet']);
  });

  it('--dry-run: one file per unit, the provider constants, the unit values pro rata, and the ZIP note', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => void out.push(l));
    expect(await plan(args({ dryRun: true }), configOf(s), undefined, () => undefined, { 'DE-8': provider })).toBe(0);
    const lines = out.map((l) => JSON.parse(l));
    const span = Date.parse(DATA_FLOOR) - Date.parse('2020-01-01T00:00:00Z');
    const whole = Date.parse('2030-01-01T00:00:00Z') - Date.parse('2020-01-01T00:00:00Z');
    expect(lines.slice(0, -1)).toEqual([
      expect.objectContaining({
        series: 'a/2010',
        requests: 1,
        values: 350_000,
        bytes: 1_400_000,
        archive_bytes: 1_400_000,
      }),
      expect.objectContaining({ series: 'a/2020', requests: 1, values: Math.ceil((350_000 * span) / whole) }),
    ]);
    expect(lines.at(-1).totals).toMatchObject({
      series: 2,
      requests: 2,
      zstd_ratio: 1,
      note: expect.stringMatching(/ZIP/),
    });
  });
});

describe('the committed open-archive specs (plan §3.3)', () => {
  it('project at most 3 GB of DB together (beside NL-1, A§11.4), with whatever providers are built', () => {
    let db = 0;
    for (const s of config.specs) {
      if (s.target === undefined) continue;
      const p = PROVIDERS[s.source];
      const r = planRange(s, null, null);
      if (p === undefined || typeof r === 'string') throw new Error(s.id);
      for (const u of s.series as readonly Unit[]) {
        const j = unitRange(u, r.from, r.to);
        if (j !== null) db += project(u, j.from, j.to, s.chunk_ms, p).db_bytes;
      }
    }
    expect(db).toBeLessThanOrEqual(3e9);
  });
});

describe('project: constants per provider', () => {
  const from = new Date('2020-01-01T00:00:00Z');
  const to = new Date('2020-01-11T00:00:00Z');
  it('NL-1 is the default, with a yearly probe', () => {
    const p = project(UNIT('x'), from, to, 864_000_000);
    expect(p).toMatchObject({ chunks: 1, requests: 2, values: 960 });
    expect(p.bytes).toBe(960 * NL1_DRY_RUN.bytes_per_value);
    expect(project(UNIT('x'), from, to, 864_000_000, PROVIDERS['NL-1'])).toEqual(p);
  });
  it("a provider's own constants, no probe without checkRequest", () => {
    const p = project(UNIT('x'), from, to, 86_400_000, {
      dryRun: { bytes_per_value: 113, zstd_ratio: 10, db_bytes_per_row: 90 },
    });
    expect(p).toEqual({
      series: 'x',
      chunks: 10,
      requests: 10,
      values: 960,
      bytes: 960 * 113,
      db_bytes: 960 * 90,
      archive_bytes: Math.ceil((960 * 113) / 10),
    });
  });
});
