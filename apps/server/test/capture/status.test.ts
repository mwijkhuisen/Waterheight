import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Counters } from '../../src/capture/runner.ts';
import { removeStaleTmp, type SpecState } from '../../src/capture/state.ts';
import { CaptureStatus, isFresh, writeDailyReport, writeSeedReport, writeStatus } from '../../src/capture/status.ts';
import { registry, spec } from './helpers.ts';

// Criterion "[CI] Owner-audience capture … A test writes a status cycle and
// shows that their state lands only in owner/status/capture.json, while
// public/status/capture.json contains no owner source ID or host (grep) and
// only the owner_specs count" (issue #16), plus the contract shape.

const NOW = new Date('2026-10-02T12:00:30Z');
const OWNER_SOURCES = ['BE-3', 'LU-2', 'LU-3', 'LU-4', 'DE-2', 'DE-3', 'CANARY-OWNER'];
const OWNER_HOSTS = ['hydrometrie.wallonie.be', 'inondations.public.lu', 'vorhersage.bafg.de'];

function cycle() {
  const root = mkdtempSync(join(tmpdir(), 'rws-status-'));
  const paths = {
    rawDir: join(root, 'raw'),
    statusDir: join(root, 'public/status'),
    ownerStatusDir: join(root, 'owner/status'),
  };
  const states = new Map<string, SpecState>();
  const counters = new Counters();
  for (const s of registry.specs) {
    states.set(s.id, {
      enabled_since: '2026-10-01T00:00:00.000Z',
      last_attempt: '2026-10-02T11:59:00.000Z',
      last_success: s.id === 'lu-3-percentile' ? '2026-10-02T08:00:00.000Z' : '2026-10-02T11:59:30.000Z',
      last_failure_status: s.id === 'be-3-values' ? 503 : null,
      variants: {},
      seen: [],
      pending_page: [],
    });
    counters.record('2026-10-02', s.source, 'ok');
    counters.addBytes('2026-10-02', s.source, s.id, 1000);
    counters.alert({ spec: s.id, kind: 'shape_changed', at: NOW.toISOString() });
  }
  const seeds = [
    {
      spec: 'fr-1-obs',
      audience: 'public' as const,
      series: 1,
      days_covered: 29.9,
      files: 240,
      done_at: '2026-10-02T09:00:00.000Z',
    },
    {
      spec: 'lu-2-json',
      audience: 'owner' as const,
      series: 39,
      days_covered: 7,
      files: 39,
      done_at: '2026-10-02T08:00:00.000Z',
    },
  ];
  return {
    paths,
    input: { registry, states, counters, seeds, nextDue: () => new Date('2026-10-02T12:10:00Z'), now: NOW },
  };
}

describe('status files', () => {
  it('keep owner state out of the public file: no owner ID, spec, host or basis, only the owner_specs count', async () => {
    const { paths, input } = cycle();
    await writeStatus(paths, input);
    const pub = readFileSync(join(paths.statusDir, 'capture.json'), 'utf8');
    const own = readFileSync(join(paths.ownerStatusDir, 'capture.json'), 'utf8');
    const ownerSpecs = registry.specs.filter((s) => s.audience === 'owner').map((s) => s.id);
    for (const needle of [...OWNER_SOURCES, ...ownerSpecs, ...OWNER_HOSTS, 'private_basis', 'lu-2-json']) {
      expect(pub, needle).not.toContain(needle);
    }
    // No hostname at all, public or owner, and no URL.
    for (const host of [...registry.hosts.values()].flat()) expect(pub, host).not.toContain(host);
    expect(pub).not.toMatch(/https?:\/\//);
    const p = CaptureStatus.parse(JSON.parse(pub));
    expect(p.owner_specs).toEqual({ fresh: ownerSpecs.length - 1, total: ownerSpecs.length }); // lu-3 is stale
    expect(p.specs.every((s) => registry.sources.get(s.source)?.audience === 'public')).toBe(true);
    expect(p.seeds.map((s) => s.spec)).toEqual(['fr-1-obs']);
    // The owner file: owner specs and the LU-2 seed, no owner_specs.
    const o = CaptureStatus.parse(JSON.parse(own));
    expect(o.owner_specs).toBeUndefined();
    expect(o.specs.map((s) => s.spec).sort()).toEqual(ownerSpecs.sort());
    expect(o.seeds.map((s) => s.spec)).toEqual(['lu-2-json']);
    expect(o.specs.find((s) => s.spec === 'be-3-values')?.last_failure_status).toBe(503);
    expect(statSync(join(paths.statusDir, 'capture.json')).mode & 0o777).toBe(0o644);
    expect(statSync(join(paths.ownerStatusDir, 'capture.json')).mode & 0o777).toBe(0o640);
  });

  it('write exactly the contract fields, days[] for the last 3 UTC days per source', async () => {
    const { paths, input } = cycle();
    await writeStatus(paths, input);
    const p = JSON.parse(readFileSync(join(paths.statusDir, 'capture.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(['days', 'generated_at', 'owner_specs', 'seeds', 'specs']);
    const s = CaptureStatus.parse(p);
    expect(Object.keys(s.specs[0] ?? {}).sort()).toEqual(
      [
        'bytes_today',
        'cadence_s',
        'failed_items',
        'last_failure_status',
        'last_success',
        'next_due',
        'source',
        'spec',
      ].sort(),
    );
    expect(new Set(s.days.map((d) => d.date))).toEqual(new Set(['2026-09-30', '2026-10-01', '2026-10-02']));
    const today = s.days.find((d) => d.source === 'NL-1' && d.date === '2026-10-02');
    expect(today?.scheduled).toBe(today ? today.ok + today.upstream_5xx + today.timeouts + today.other : -1);
    expect(Object.keys(today?.bytes ?? {}).every((id) => id.startsWith('nl-1-'))).toBe(true);
    // Seed-only specs are not scheduled specs.
    expect(s.specs.some((x) => x.spec === 'fr-3-obs' || x.spec === 'ch-3-40d')).toBe(false);
  });

  it('name at most 20 failed items, pattern-checked, an owner spec’s only in the owner file (#39)', async () => {
    const { paths, input } = cycle();
    const items = Array.from({ length: 25 }, (_, i) => `A85006${String(i).padStart(4, '0')}/H`);
    items[1] = '../etc';
    items[2] = `x${'y'.repeat(64)}`;
    items[3] = 'file/0ebe38da-f4fa-4132-8fc0-47074d9186d0';
    const fr4 = input.states.get('fr-4') as SpecState;
    input.states.set('fr-4', { ...fr4, failed_items: items });
    const be3 = input.states.get('be-3-values') as SpecState;
    input.states.set('be-3-values', { ...be3, failed_items: ['OWNERITEM1'] });
    await writeStatus(paths, input);
    const pub = readFileSync(join(paths.statusDir, 'capture.json'), 'utf8');
    const own = readFileSync(join(paths.ownerStatusDir, 'capture.json'), 'utf8');
    const p = CaptureStatus.parse(JSON.parse(pub));
    expect(p.specs.find((s) => s.spec === 'fr-4')?.failed_items).toEqual([
      items[0],
      'other',
      'other',
      items[3],
      ...items.slice(4, 20),
    ]);
    expect(p.specs.find((s) => s.spec === 'nl-2-wfs')?.failed_items).toEqual([]);
    expect(pub).not.toContain('OWNERITEM1');
    const o = CaptureStatus.parse(JSON.parse(own));
    expect(o.specs.find((s) => s.spec === 'be-3-values')?.failed_items).toEqual(['OWNERITEM1']);
    // A file of the previous release (no failed_items) still parses; a 21st item or a bad key does not.
    const spec0 = { ...(p.specs[0] as object), failed_items: undefined };
    expect(CaptureStatus.safeParse({ ...p, specs: [spec0] }).success).toBe(true);
    const many = { ...p.specs[0], failed_items: items.slice(0, 21).map(() => 'A850060000/H') };
    expect(CaptureStatus.safeParse({ ...p, specs: [many] }).success).toBe(false);
    expect(CaptureStatus.safeParse({ ...p, specs: [{ ...p.specs[0], failed_items: ['../etc'] }] }).success).toBe(false);
  });

  it('split the daily report and the seed report by audience', async () => {
    const { paths, input } = cycle();
    await writeDailyReport(paths, registry, input.counters, '2026-10-02');
    await writeSeedReport(paths, input.seeds);
    const pub = readFileSync(join(paths.rawDir, '_reports', '2026-10-02.json'), 'utf8');
    const own = readFileSync(join(paths.ownerStatusDir, 'reports', '2026-10-02.json'), 'utf8');
    for (const needle of [...OWNER_SOURCES, 'be-3-values', 'lu-3-percentile']) expect(pub).not.toContain(needle);
    expect(own).toContain('be-3-values');
    const seedReport = readFileSync(join(paths.rawDir, '_reports', 'seed-report.json'), 'utf8');
    expect(seedReport).toContain('fr-1-obs');
    expect(seedReport).not.toContain('lu-2');
  });

  it('count a spec as fresh within 3 × cadence, and a never-attempted one from when it was enabled', () => {
    const s = spec('nl-1-obs-key');
    const base = { variants: {}, seen: [], pending_page: [] };
    expect(isFresh(s, { ...base, enabled_since: '2026-10-02T11:50:00Z' }, NOW)).toBe(true);
    expect(isFresh(s, { ...base, enabled_since: '2026-10-02T11:00:00Z' }, NOW)).toBe(false);
    expect(
      isFresh(s, { ...base, enabled_since: '2026-10-02T11:50:00Z', last_attempt: '2026-10-02T11:51:00Z' }, NOW),
    ).toBe(false);
    expect(
      isFresh(s, { ...base, enabled_since: '2026-10-01T00:00:00Z', last_success: '2026-10-02T11:31:00Z' }, NOW),
    ).toBe(true);
    expect(
      isFresh(s, { ...base, enabled_since: '2026-10-01T00:00:00Z', last_success: '2026-10-02T11:29:00Z' }, NOW),
    ).toBe(false);
  });
});

describe('stale tmp files (C12)', () => {
  it('are removed at start: only capture.json tmp files in the served dir, every JSON tmp in our own dirs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rws-tmp-'));
    const status = join(root, 'status');
    const owner = join(root, 'owner');
    mkdirSync(status);
    mkdirSync(join(owner, 'reports'), { recursive: true });
    for (const f of ['capture.json.4711.tmp', 'capture.json', 'ops.json.77.tmp']) writeFileSync(join(status, f), '{}');
    for (const f of ['capture.json.4711.tmp', 'reports/2026-10-01.json.4711.tmp', 'reports/2026-10-01.json'])
      writeFileSync(join(owner, f), '{}');
    expect(await removeStaleTmp(status, /^capture\.json\.\d+\.tmp$/)).toBe(1);
    expect(await removeStaleTmp(owner)).toBe(1);
    expect(await removeStaleTmp(join(owner, 'reports'))).toBe(1);
    expect(existsSync(join(status, 'capture.json.4711.tmp'))).toBe(false);
    expect(existsSync(join(status, 'ops.json.77.tmp'))).toBe(true); // P1b's
    expect(existsSync(join(status, 'capture.json'))).toBe(true);
    expect(existsSync(join(owner, 'reports/2026-10-01.json.4711.tmp'))).toBe(false);
    expect(existsSync(join(owner, 'reports/2026-10-01.json'))).toBe(true);
    expect(await removeStaleTmp(join(root, 'missing'))).toBe(0);
  });

  it('never follow a link, nor descend into a directory (N4)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rws-tmp-'));
    const outside = join(root, 'outside');
    const state = join(root, 'state');
    mkdirSync(outside);
    mkdirSync(join(state, 'sub'), { recursive: true });
    for (const f of [join(outside, 'x.json.1.tmp'), join(state, 'a.json.2.tmp'), join(state, 'sub', 'b.json.3.tmp')])
      writeFileSync(f, '{}');
    symlinkSync(outside, join(state, 'link'));
    symlinkSync(join(outside, 'x.json.1.tmp'), join(state, 'c.json.4.tmp'));
    expect(await removeStaleTmp(state)).toBe(1);
    expect(existsSync(join(state, 'a.json.2.tmp'))).toBe(false);
    expect(existsSync(join(outside, 'x.json.1.tmp'))).toBe(true);
    expect(existsSync(join(state, 'c.json.4.tmp'))).toBe(true); // the link itself stays too
    expect(existsSync(join(state, 'sub', 'b.json.3.tmp'))).toBe(true);
  });
});
