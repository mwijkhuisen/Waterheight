import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANARIES } from '@rws/contracts';
import { OwnerStatusFile, StatusFile } from '@rws/contracts/status';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/pool.ts';
import { publishTail } from '../../src/load/migrate.ts';
import type { PublisherStatus } from '../../src/publish/cycle.ts';
import { readInput, status } from '../../src/publish/render/status.ts';
import { type Harness, harness } from '../load/harness.ts';
import { ctxFor, NOW, OWNER_IDS } from './s2-ctx.ts';

// P9a: status.json of both families: coarse, the capture and ops files read defensively (a missing, garbage, large or
// symlinked input is null, never a failed status) and no owner source in the public file (invariant 11).

let h: Harness;
let pubDb: Db;
let ownDb: Db;
let dir: string;
const at = new Date(NOW - 60_000).toISOString();
const P: PublisherStatus = {
  cycleAt: new Date(NOW).toISOString(),
  cycleSeconds: 3,
  lastDayRender: null,
  pendingDays: 0,
  settledBytes: 0,
};
const spec = (source: string, id: string) => ({
  source,
  spec: id,
  cadence_s: 600,
  last_success: at,
  last_failure_status: 503,
  next_due: at,
  bytes_today: 42,
  failed_items: ['item-1'],
});
const capture = {
  generated_at: at,
  // A stray owner spec in the public copy: dropped, never published.
  specs: [spec('NL-1', 'nl-1-levels'), spec('BE-3', 'be-3-levels')],
  days: [],
  seeds: [],
  owner_specs: { fresh: 5, total: 6 },
};
const ops = { generated_at: at, last_backup: at, drill: { at, sampled: 3, matched: 3 }, disk_pct: 41 };

beforeAll(async () => {
  h = await harness();
  pubDb = h.dbAs('rws_publish', 1);
  ownDb = h.dbAs('rws_owner_api', 1);
  await publishTail(h.dbAs('rws_migrator', 1).db, new Date(NOW));
  // What the loader's health pass stores: a public source with coverage and a forecast, an owner one.
  const detail = {
    coverage: {
      from: at,
      ratio: 0.97,
      series: 4,
      series_below_95: 1,
      gaps: [],
      hostile: 'https://secret.example/x?k=1',
    },
    forecast: { issued_at: at, run_age_s: 60, series: 3, current: 2, late: null },
  };
  await h.t.admin.query(
    `INSERT INTO source_health (source_id, status, lag_p95, last_fetch_ok, detail) VALUES
       ('DE-1', 'ok', '34 seconds', $1, $2::jsonb), ('BE-3', 'degraded', '90 seconds', $1, '{}')`,
    [at, JSON.stringify(detail)],
  );
}, 120_000);
afterAll(() => h.close());
const fresh = () => {
  dir = mkdtempSync(join(tmpdir(), 'rws-status-'));
  return dir;
};
const put = (name: string, body: unknown) => writeFileSync(join(dir, name), JSON.stringify(body));
const pubStatus = async (inputs?: string) => status(await ctxFor(pubDb, 'public', { inputs }), P);

describe('readInput', () => {
  it('reads a regular file and gives null for a missing, garbage, large, symlinked or absent directory', async () => {
    fresh();
    put('a.json', { x: 1 });
    expect(await readInput(dir, 'a.json')).toEqual({ x: 1 });
    expect(await readInput(dir, 'none.json')).toBeNull();
    writeFileSync(join(dir, 'g.json'), '{not json');
    expect(await readInput(dir, 'g.json')).toBeNull();
    writeFileSync(join(dir, 'big.json'), `"${'x'.repeat(1024 * 1024)}"`);
    expect(await readInput(dir, 'big.json')).toBeNull();
    symlinkSync(join(dir, 'a.json'), join(dir, 'link.json'));
    expect(await readInput(dir, 'link.json')).toBeNull();
    mkdirSync(join(dir, 'd.json'));
    expect(await readInput(dir, 'd.json')).toBeNull();
    expect(await readInput(undefined, 'a.json')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('status.json', { timeout: 120_000 }, () => {
  it('the public file parses, maps capture and ops coarsely and names no owner source or canary', async () => {
    fresh();
    put('capture.json', capture);
    put('ops.json', ops);
    const body = await pubStatus(dir);
    const file = StatusFile.parse(body);
    expect(file.capture).toEqual({
      generatedAt: at,
      specs: [{ source: 'NL-1', spec: 'nl-1-levels', cadenceS: 600, lastSuccess: at, bytesToday: 42 }],
      ownerSpecs: { fresh: 5, total: 6 },
    });
    expect(file.ops).toEqual({ lastBackup: at, drill: at, diskPct: 41 });
    expect(file.publisher).toEqual(P);
    expect(file.ownerSources.total).toBeGreaterThan(0);
    expect(file.loader.lastCommit).toBeNull();
    const text = JSON.stringify(body);
    for (const id of OWNER_IDS) expect(text, id).not.toContain(`"${id}"`);
    for (const c of [
      CANARIES.owner.text,
      CANARIES.owner.real,
      CANARIES.withheld.text,
      'CANARY',
      'failed_items',
      'last_failure',
    ])
      expect(text).not.toContain(c);
    expect(file.sources).toEqual([
      {
        id: 'DE-1',
        status: 'ok',
        lastFetchOk: at,
        newestTs: null,
        lagP95S: 34,
        coverage: 0.97,
        forecast: { issuedAt: at, runAgeS: 60, series: 3, current: 2, late: null },
      },
    ]);
    expect(file.loader.lagP95S).toBe(34);
    expect(text).not.toContain('secret.example');
    // The attribution names only sources the file names.
    const named = new Set([...file.sources.map((x) => x.id), ...(file.capture?.specs.map((x) => x.source) ?? [])]);
    for (const a of file.attribution) expect(named.has(a.source), a.source).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('missing, garbage or symlinked inputs give null capture and ops, never a failed status', async () => {
    fresh();
    for (const inputs of [undefined, dir]) {
      const file = StatusFile.parse(await pubStatus(inputs));
      expect([file.capture, file.ops]).toEqual([null, null]);
    }
    writeFileSync(join(dir, 'capture.json'), '[]');
    writeFileSync(join(dir, 'ops.json'), JSON.stringify({ ...ops, disk_pct: 400 }));
    const bad = StatusFile.parse(await pubStatus(dir));
    expect([bad.capture, bad.ops]).toEqual([null, null]);
    rmSync(join(dir, 'capture.json'));
    put('real.json', capture);
    symlinkSync(join(dir, 'real.json'), join(dir, 'capture.json'));
    expect(StatusFile.parse(await pubStatus(dir)).capture).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the owner file parses: the owner family sources, both coverage halves, no loader backlog, no ownerSources', async () => {
    fresh();
    put('capture.json', {
      ...capture,
      owner_specs: undefined,
      specs: [spec('BE-3', 'be-3-levels'), spec('NL-1', 'nl-1-levels')],
    });
    const body = await status(await ctxFor(ownDb, 'owner', { inputs: dir }), P);
    const file = OwnerStatusFile.parse(body);
    expect(file.loader.backlogAgeS).toBeNull();
    expect(file.capture?.ownerSpecs).toBeNull();
    expect(file.capture?.specs.map((s) => s.source).sort()).toEqual(['BE-3', 'NL-1']);
    expect(file.classification.owner).not.toBeNull();
    expect(file.classification.public).not.toBeNull();
    // The public split of the owner read equals the public family's own coverage.
    expect(file.forecastCoverage.public).not.toBeNull();
    expect(file.forecastCoverage.public).toEqual(StatusFile.parse(await pubStatus(undefined)).forecastCoverage);
    expect(file.sources.map((x) => x.id)).toEqual(['BE-3', 'DE-1']);
    expect(file.sources[0]?.status).toBe('degraded');
    expect(JSON.stringify(body)).not.toContain('ownerSources');
    rmSync(dir, { recursive: true, force: true });
  });
});
