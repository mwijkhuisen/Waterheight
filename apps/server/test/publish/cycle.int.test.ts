import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANARIES, dayOf } from '@rws/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StaticCache } from '../../src/api/states.ts';
import { coded } from '../../src/api/util.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import { Publisher, type RenderCtx, type Renderers } from '../../src/publish/cycle.ts';
import { publishOnce } from '../../src/publish/index.ts';
import { Output } from '../../src/publish/write.ts';
import { type Harness, harness } from '../load/harness.ts';

// P9a: the publisher's cycle against the real views with stand-in renderers (the renderers have their own tests):
// what it writes where, the settled-day markers and versions, the prune, meta last, and the canary refusal.

const NOW = Date.parse('2026-10-04T12:05:00Z');
const H = 3_600_000;
let h: Harness;
let dir: string;
let calls: string[];

const attribution: never[] = [];
const columns = {
  series: [],
  ageSeconds: [],
  value: [],
  qc: [],
  state: [],
  basis: [],
  bases: [],
  section: [],
  area: [],
  nap: [],
  zero: [],
};
const iso = (ms: number) => new Date(ms).toISOString();

function fake(over: Partial<Renderers> = {}): Renderers {
  const log =
    <A extends unknown[], R>(name: string, body: (c: RenderCtx, ...a: A) => R) =>
    async (c: RenderCtx, ...a: A): Promise<Awaited<R>> => {
      calls.push(name);
      return await body(c, ...a);
    };
  return {
    stations: log('stations', () => ({ schemaVersion: 2, seriesHash: '0'.repeat(16), stations: [], attribution })),
    latest: log('latest', (c) => ({
      body: {
        schemaVersion: 1,
        t: iso(c.now - (c.now % 600_000)),
        ...columns,
        generatedAt: iso(c.now),
        seriesHash: '0'.repeat(16),
        dh24: [],
        dh1: [],
        lapsed: [],
        lapsedAge: [],
        attribution,
      },
      latestFrom: iso(c.now - 60_000),
    })),
    snapshot: log('snapshot', (_c, t: number) => ({ schemaVersion: 1, t: iso(t), ...columns, attribution })),
    frames: log('frames', (_c, from: number, to: number) => ({
      schemaVersion: 1,
      from: iso(from),
      to: iso(to),
      stepSeconds: 3600,
      series: [],
      vlast: [],
      attribution,
    })),
    forecast: log('forecast', (c) => ({ schemaVersion: 1, now: iso(c.now), runs: [], attribution })),
    warnings: log('warnings', (c, day: string | null) => ({
      type: 'FeatureCollection',
      schemaVersion: 1,
      generatedAt: iso(c.now),
      day,
      features: [],
      attribution,
    })),
    sources: log('sources', (c) => ({ schemaVersion: 1, generatedAt: iso(c.now), sources: [], attribution })),
    station: log('station', () => {
      throw new Error('no stations here');
    }),
    status: log('status', (c, p) => ({
      schemaVersion: 1,
      generatedAt: iso(c.now),
      twins: { ok: 0, failing: 0 },
      ops: null,
      loader: { lastCommit: null, lagP95S: null, backlogAgeS: null },
      publisher: p,
      sources: [],
      ...(c.family === 'public'
        ? { classification: null, forecastCoverage: null, ownerSources: { healthy: 0, total: 0 } }
        : { classification: { public: null, owner: null }, forecastCoverage: { public: null, owner: null } }),
      capture: null,
      attribution,
    })),
    meta: log('meta', (c, m) => ({
      now: iso(c.now),
      dataEpoch: iso(c.window.dataEpochMs),
      displayStart: iso(c.window.displayStartMs),
      build: 'dev',
      sources: [],
      forecastHorizons: [],
      schemaVersion: 1,
      generatedAt: iso(c.now),
      ...m,
      attribution,
    })),
    ...over,
  };
}

const read = (rel: string) => JSON.parse(readFileSync(join(dir, 'v1', rel), 'utf8'));
const ls = (rel: string) => readdirSync(join(dir, rel)).sort();
const setVersions = (family: string, map: Record<string, number>) =>
  h.t.admin.query(
    `INSERT INTO app_meta (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      `day_versions:${family}`,
      JSON.stringify(
        Object.fromEntries(Object.entries(map).map(([d, v]) => [d, { v, reason: 'revision', at: iso(NOW) }])),
      ),
    ],
  );

beforeAll(async () => {
  h = await harness();
  // Display from 2026-10-01: one settled day at NOW (2026-10-01), three unsettled ones.
  await h.t.admin.query(`UPDATE app_meta SET value = '"2026-10-01T00:00:00Z"' WHERE key = 'display_start'`);
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rws-cycle-'));
  calls = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('publish cycle', { timeout: 120_000 }, () => {
  it('writes the whole public tree, the settled day with its marker, and meta.json last', async () => {
    const db = h.dbAs('rws_publish');
    await publishOnce(db.db, 'public', dir, { now: NOW, render: fake() });
    expect(calls.at(-1)).toBe('meta');
    expect(calls.at(-2)).toBe('status');
    expect(ls('v1')).toEqual([
      'forecast',
      'frames',
      'latest.json',
      'latest.json.gz',
      'latest.json.zst',
      'meta.json',
      'meta.json.gz',
      'meta.json.zst',
      'recent',
      'settled',
      'sources.json',
      'sources.json.gz',
      'sources.json.zst',
      'stations.json',
      'stations.json.gz',
      'stations.json.zst',
      'status.json',
      'status.json.gz',
      'status.json.zst',
      'warnings',
    ]);
    expect(ls('v1/recent')).toEqual(['2026-10-02', '2026-10-03', '2026-10-04']);
    expect(ls('v1/recent/2026-10-04').filter((f) => f.endsWith('.json'))).toHaveLength(73);
    expect(ls('v1/settled/2026-10-01/v1').filter((f) => f.endsWith('.json'))).toHaveLength(144);
    expect(ls('v1/frames')).toEqual(['2026-10-01', 'recent.json', 'recent.json.gz', 'recent.json.zst']);
    expect(ls('v1/warnings').filter((f) => f.endsWith('.json'))).toEqual([
      '2026-10-01.json',
      '2026-10-02.json',
      '2026-10-03.json',
      'today.json',
    ]);
    expect(read('warnings/today.json').day).toBe('2026-10-04');
    expect(ls('.state')).toEqual(['settled-2026-10-01-v1.done']);
    expect(ls('.tmp')).toEqual([]);
    const meta = read('meta.json');
    expect(meta).toMatchObject({ dayVersions: {}, degraded: false, latestFrom: iso(NOW - 60_000) });
    expect(read('status.json').publisher).toMatchObject({
      pendingDays: 0,
      lastDayRender: { day: '2026-10-01', version: 1 },
    });
    expect(read('frames/recent.json')).toMatchObject({
      from: '2026-10-02T00:00:00.000Z',
      to: '2026-10-04T13:00:00.000Z',
    });
    // Regular files and directories only: the publisher never makes a link.
    const walk = (p: string): void => {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const st = lstatSync(join(p, e.name));
        expect(st.isFile() || st.isDirectory(), join(p, e.name)).toBe(true);
        if (st.isDirectory()) walk(join(p, e.name));
      }
    };
    walk(dir);
  });

  it('renders a bumped day under its new version, keeps the old one 1 h, then prunes it', async () => {
    const db = h.dbAs('rws_publish');
    await publishOnce(db.db, 'public', dir, { now: NOW, render: fake() });
    await setVersions('public', { '2026-10-01': 2 });
    await publishOnce(db.db, 'public', dir, { now: NOW + 60_000, render: fake() });
    expect(ls('v1/settled/2026-10-01')).toEqual(['v1', 'v2']);
    expect(read('meta.json').dayVersions).toEqual({ '2026-10-01': 2 });
    expect(ls('.state')).toEqual(['settled-2026-10-01-v1.done', 'settled-2026-10-01-v2.done']);
    await publishOnce(db.db, 'public', dir, { now: NOW + 60_000 + H, render: fake() });
    expect(ls('v1/settled/2026-10-01')).toEqual(['v2']);
    expect(ls('v1/frames/2026-10-01').filter((f) => f.endsWith('.json'))).toEqual(['v2.json']);
    expect(ls('.state')).toEqual(['settled-2026-10-01-v2.done']);
    await setVersions('public', {});
  });

  it('drops a version bumped while it renders, and meta never names it', async () => {
    const db = h.dbAs('rws_publish');
    let bumped = false;
    const render = fake({
      snapshot: async (_c, t) => {
        if (!bumped && dayOf(t) === '2026-10-01') {
          bumped = true;
          await setVersions('public', { '2026-10-01': 2 });
        }
        return { schemaVersion: 1, t: iso(t), ...columns, attribution };
      },
    });
    await publishOnce(db.db, 'public', dir, { now: NOW, render });
    // v1 was dropped after its render; the same publishOnce went on to render v2 (no per-cycle limit).
    expect(ls('v1/settled/2026-10-01')).toEqual(['v2']);
    expect(ls('.state')).toEqual(['settled-2026-10-01-v2.done']);
    expect(read('meta.json').dayVersions).toEqual({ '2026-10-01': 2 });
    await setVersions('public', {});
  });

  it('skips one failing bucket or station, never the rest; a failing hot step makes meta degraded (CR-1, CR-2)', async () => {
    const db = h.dbAs('rws_publish');
    const bad = Date.parse('2026-10-03T12:00:00Z');
    const errors: Record<string, unknown>[] = [];
    const render = fake({
      snapshot: async (_c, t) => {
        if (t === bad) throw coded('render_failed');
        return { schemaVersion: 1, t: iso(t), ...columns, attribution };
      },
      latest: async () => {
        throw coded('render_failed');
      },
    });
    const p = new Publisher({
      db: db.db,
      family: 'public',
      out: new Output(dir),
      render,
      window: new DisplayWindow(db.db, undefined, 'public'),
      now: () => NOW,
      build: 'dev',
      sections: new Map(),
      cache: new StaticCache(60_000, () => NOW),
      inputs: undefined,
      log: { error: (o: Record<string, unknown>) => errors.push(o) },
      budgetMs: Number.POSITIVE_INFINITY,
      settledPerCycle: 1,
      strict: false,
    });
    await p.cycle();
    const day = ls('v1/recent/2026-10-03').filter((f) => f.endsWith('.json'));
    expect(day).toHaveLength(143);
    expect(day).not.toContain('1200.json');
    expect(ls('v1/recent/2026-10-04').filter((f) => f.endsWith('.json'))).toHaveLength(73);
    expect(ls('v1')).not.toContain('latest.json');
    expect(read('meta.json')).toMatchObject({ degraded: true });
    expect(errors).toContainEqual(expect.objectContaining({ code: 'render_failed', step: 'recent' }));
    expect(errors).toContainEqual(expect.objectContaining({ code: 'render_failed', step: 'latest' }));
  });

  it('refuses a public body that holds a canary rendering; the owner family takes the owner canary only', async () => {
    const withValue = (value: string) =>
      fake({
        sources: async (c) => ({
          schemaVersion: 1,
          generatedAt: iso(c.now),
          sources: [],
          attribution: [
            {
              source: 'DE-1',
              lang: null,
              text: value,
              url: null,
              required: true,
              dateKind: null,
              date: null,
              dateText: null,
            },
          ],
        }),
      });
    const pub = h.dbAs('rws_publish');
    await expect(
      publishOnce(pub.db, 'public', dir, { now: NOW, render: withValue(CANARIES.owner.real) }),
    ).rejects.toThrow('canary_in_output');
    const own = h.dbAs('rws_owner_api');
    await expect(
      publishOnce(own.db, 'owner', dir, { now: NOW, render: withValue(CANARIES.withheld.text) }),
    ).rejects.toThrow('canary_in_output');
    // The owner family: no settled files, no frames; the ended days' warnings and today's (#86); meta has the version
    // map, never 0.
    rmSync(dir, { recursive: true, force: true });
    await publishOnce(own.db, 'owner', dir, { now: NOW, render: withValue(CANARIES.owner.text) });
    expect(ls('v1').filter((f) => !f.includes('.json'))).toEqual(['forecast', 'recent', 'warnings']);
    expect(ls('v1/recent')).toEqual(['2026-10-02', '2026-10-03', '2026-10-04']);
    expect(ls('v1/warnings').filter((f) => /\.(geo)?json$/.test(f))).toEqual([
      '2026-10-01.json',
      '2026-10-02.json',
      '2026-10-03.json',
      'latest.geojson',
      'today.json',
    ]);
    expect(read('warnings/today.json').day).toBe('2026-10-04');
    expect(read('meta.json').dayVersions).toEqual({});
  });
});
