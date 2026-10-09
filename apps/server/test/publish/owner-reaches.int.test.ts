import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { ReachesFile } from '@rws/contracts';
import { checkOwnerReaches, OwnerReachesFile } from '@rws/contracts/reaches-owner';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StaticCache } from '../../src/api/states.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import type { ChannelAudience } from '../../src/db/audience.ts';
import type { Db } from '../../src/db/pool.ts';
import { RegistryError, readRiverRegistry } from '../../src/load/registry-sync.ts';
import { Publisher } from '../../src/publish/cycle.ts';
import { publishOnce } from '../../src/publish/index.ts';
import { RENDERERS } from '../../src/publish/render/index.ts';
import { Output } from '../../src/publish/write.ts';
import { type Harness, harness } from '../load/harness.ts';

// P11a (D-C, criterion C5): the owner publisher's step that splits the installed river release at the owner stations,
// against the real views and renderers: a fixture rivers directory (manifest + reaches file with the right sha256 and
// bytes) and a temp www. The public publisher never builds the file.

const NOW = Date.parse('2026-10-04T12:05:00Z');
const FIXTURE = readFileSync(join(import.meta.dirname, '../../../../test/fixtures/reaches-fixture.json'));
const VERSION = '20261003';
const OLDER = '20261001';
let h: Harness;
let pubDb: Db;
let ownDb: Db;
let dir: string;
let rivers: string;

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const entry = (file: string, bytes: Buffer) => ({ file, sha256: sha(bytes), bytes: bytes.length });
const reachesBytes = (version: string) => Buffer.from(JSON.stringify({ ...JSON.parse(FIXTURE.toString()), version }));

/** A rivers directory as rws-rivers-refresh leaves it: the files of the releases and the manifest. */
function install(
  current: string,
  previous: string | null,
  over: (m: Record<string, unknown>) => void = () => undefined,
) {
  const release = (version: string) => {
    const bytes = reachesBytes(version);
    writeFileSync(join(rivers, `reaches-${version}.json`), bytes);
    return {
      version,
      tag: 'geo-2026-10-03',
      installed_at: '2026-10-03T06:00:00Z',
      tiles: { file: `rivers-${version}.pmtiles`, sha256: 'a'.repeat(64), bytes: 1000 },
      reaches: entry(`reaches-${version}.json`, bytes),
      download: { file: `rivers-${version}.geojson.gz`, sha256: 'b'.repeat(64), bytes: 1000 },
    };
  };
  const manifest: Record<string, unknown> = {
    schema_version: 1,
    current: release(current),
    previous: previous === null ? null : release(previous),
  };
  over(manifest);
  writeFileSync(join(rivers, 'manifest.json'), JSON.stringify(manifest));
}

const readRel = (rel: string) => readFileSync(join(dir, 'v1', rel));
const listRivers = () => (existsSync(join(dir, 'v1/rivers')) ? readdirSync(join(dir, 'v1/rivers')).sort() : []);

function publisher(family: ChannelAudience, over: Partial<ConstructorParameters<typeof Publisher>[0]> = {}) {
  const errors: Record<string, unknown>[] = [];
  const db = family === 'public' ? pubDb : ownDb;
  const p = new Publisher({
    db: db.db,
    family,
    out: new Output(dir),
    render: RENDERERS,
    window: new DisplayWindow(db.db, undefined, family),
    now: () => NOW,
    build: 'dev',
    sections: new Map(),
    cache: new StaticCache(60_000, () => NOW),
    inputs: undefined,
    riversDir: rivers,
    log: { error: (o: Record<string, unknown>) => errors.push(o) },
    // No time for recent buckets and station files: this test is about the reaches step (step 1 has no budget).
    budgetMs: 0,
    settledPerCycle: 0,
    strict: false,
    ...over,
  });
  return { p, errors };
}

beforeAll(async () => {
  h = await harness();
  pubDb = h.dbAs('rws_publish', 3);
  ownDb = h.dbAs('rws_owner_api', 3);
  await h.t.admin.query(`UPDATE app_meta SET value = '"2026-10-01T00:00:00Z"' WHERE key = 'display_start'`);
}, 120_000);
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rws-owner-reaches-'));
  rivers = mkdtempSync(join(tmpdir(), 'rws-rivers-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(rivers, { recursive: true, force: true });
});

describe('the owner reaches step', { timeout: 120_000 }, () => {
  it('writes the variant of the current and the previous release, with its siblings, split at the owner stations', async () => {
    install(VERSION, OLDER);
    const { p, errors } = publisher('owner');
    await p.cycle();
    expect(errors).toEqual([]);
    expect(listRivers()).toEqual([
      `reaches-${OLDER}.json`,
      `reaches-${OLDER}.json.gz`,
      `reaches-${OLDER}.json.zst`,
      `reaches-${VERSION}.json`,
      `reaches-${VERSION}.json.gz`,
      `reaches-${VERSION}.json.zst`,
    ]);
    const plain = readRel(`rivers/reaches-${VERSION}.json`);
    expect(gunzipSync(readRel(`rivers/reaches-${VERSION}.json.gz`)).equals(plain)).toBe(true);
    expect(zstdDecompressSync(readRel(`rivers/reaches-${VERSION}.json.zst`)).equals(plain)).toBe(true);
    const file = OwnerReachesFile.parse(JSON.parse(plain.toString()));
    expect(checkOwnerReaches(file)).toEqual([]);
    expect(file.version).toBe(VERSION);
    expect(JSON.parse(readRel(`rivers/reaches-${OLDER}.json`).toString()).version).toBe(OLDER);
    const ids = file.stations.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['be.spw.5447', 'be.spw.5451', 'be.spw.8702']));
    expect(file.reaches.some((r) => r.part_of !== undefined)).toBe(true);
    // The public release (the fixture) has none of it, and still parses as the public file.
    expect(FIXTURE.toString()).not.toContain('be.spw.');
    expect(ReachesFile.safeParse(JSON.parse(FIXTURE.toString())).success).toBe(true);
    // The tree beside it is the usual owner tree (no mount of the public one).
    expect(existsSync(join(dir, 'v1/meta.json'))).toBe(true);
  });

  it('is idempotent: a second cycle, and a second process, leave the bytes alone; the first rewrites nothing', async () => {
    install(VERSION, null);
    const a = publisher('owner');
    await a.p.cycle();
    const path = join(dir, 'v1/rivers', `reaches-${VERSION}.json`);
    const first = readFileSync(path);
    const old = new Date('2000-01-01T00:00:00Z');
    utimesSync(path, old, old);
    await a.p.cycle();
    expect(statSync(path).mtime.getTime()).toBe(old.getTime());
    expect(readFileSync(path).equals(first)).toBe(true);
    // A new process repeats the work and arrives at the same bytes.
    const b = publisher('owner', { out: new Output(dir) });
    await b.p.cycle();
    expect(readFileSync(path).equals(first)).toBe(true);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  });

  it('removes every other reaches file: a release that rolled off, and a leftover with its siblings', async () => {
    install(VERSION, OLDER);
    const { p } = publisher('owner');
    await p.cycle();
    mkdirSync(join(dir, 'v1/rivers'), { recursive: true });
    for (const name of ['reaches-20250101.json', 'reaches-20250101.json.zst', 'reaches-20250202.json.gz'])
      writeFileSync(join(dir, 'v1/rivers', name), 'x');
    // A rollback: the older release is gone from the manifest, a new one is current.
    install('20261101', VERSION);
    await p.cycle();
    expect(listRivers().filter((n) => !n.endsWith('.zst') && !n.endsWith('.gz'))).toEqual([
      `reaches-${VERSION}.json`,
      'reaches-20261101.json',
    ]);
    expect(listRivers().filter((n) => n.includes('2025') || n.includes(OLDER))).toEqual([]);
  });

  it('survives a missing manifest, a bad one and a bad sha256 or size: nothing thrown, one fixed code each, no file', async () => {
    await publisher('owner', { strict: true }).p.cycle(); // no manifest at all, in strict mode: still no throw
    expect(listRivers()).toEqual([]);

    const missing = publisher('owner');
    await missing.p.cycle();
    await missing.p.cycle();
    await missing.p.cycle();
    expect(missing.errors.filter((e) => e.step === 'reaches')).toEqual([
      { code: 'rivers_manifest_missing', step: 'reaches', family: 'owner' },
    ]);

    writeFileSync(join(rivers, 'manifest.json'), '{"schema_version": 1');
    const broken = publisher('owner');
    await broken.p.cycle();
    expect(broken.errors.filter((e) => e.step === 'reaches')).toEqual([
      { code: 'rivers_manifest_invalid', step: 'reaches', family: 'owner' },
    ]);

    install(VERSION, null, (m) => {
      (m.current as { reaches: { sha256: string } }).reaches.sha256 = 'c'.repeat(64);
    });
    const bad = publisher('owner');
    await bad.p.cycle();
    await bad.p.cycle();
    expect(bad.errors.filter((e) => e.step === 'reaches')).toEqual([
      { code: 'rivers_reaches_mismatch', step: 'reaches', family: 'owner' },
    ]);
    install(VERSION, null, (m) => {
      (m.current as { reaches: { bytes: number } }).reaches.bytes += 1;
    });
    const size = publisher('owner');
    await size.p.cycle();
    expect(size.errors.filter((e) => e.step === 'reaches')).toEqual([
      { code: 'rivers_reaches_unreadable', step: 'reaches', family: 'owner' },
    ]);
    // A reaches file that is no valid release: right bytes and sha256, wrong content.
    const junk = Buffer.from('{"schema_version":1}');
    install(VERSION, null, (m) => {
      writeFileSync(join(rivers, `reaches-${VERSION}.json`), junk);
      (m.current as { reaches: unknown }).reaches = entry(`reaches-${VERSION}.json`, junk);
    });
    const invalid = publisher('owner');
    await invalid.p.cycle();
    expect(invalid.errors.filter((e) => e.step === 'reaches')).toEqual([
      { code: 'rivers_reaches_invalid', step: 'reaches', family: 'owner' },
    ]);
    expect(listRivers()).toEqual([]);
    // None of it hurt the rest of the tree.
    expect(existsSync(join(dir, 'v1/meta.json'))).toBe(true);
  });

  it('logs a missing or invalid rivernet.yaml once, by code, and writes nothing', async () => {
    install(VERSION, null);
    for (const [read, code] of [
      [() => null, 'rivernet_missing'],
      [
        () => {
          throw new RegistryError('provider text must never reach the log');
        },
        'rivernet_invalid',
      ],
    ] as const) {
      const { p, errors } = publisher('owner', { rivernet: read });
      await p.cycle();
      await p.cycle();
      expect(errors.filter((e) => e.step === 'reaches')).toEqual([{ code, step: 'reaches', family: 'owner' }]);
      expect(listRivers()).toEqual([]);
    }
    expect(readRiverRegistry().rivernet).not.toBeNull();
  });

  it('is rebuilt when the manifest changes the release, and not read at all when nothing changed', async () => {
    install(VERSION, null);
    const { p } = publisher('owner');
    await p.cycle();
    expect(listRivers().filter((n) => n.endsWith('.json'))).toEqual([`reaches-${VERSION}.json`]);
    install('20261101', VERSION);
    await p.cycle();
    expect(listRivers().filter((n) => n.endsWith('.json'))).toEqual([
      `reaches-${VERSION}.json`,
      'reaches-20261101.json',
    ]);
  });

  it('is never built by the public publisher: no rivers directory, whatever riversDir says, and no contract for it', async () => {
    install(VERSION, OLDER);
    const { p, errors } = publisher('public');
    await p.cycle();
    expect(errors).toEqual([]);
    expect(existsSync(join(dir, 'v1/rivers'))).toBe(false);
    expect(existsSync(join(dir, 'v1/meta.json'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
    await publishOnce(pubDb.db, 'public', dir, { now: NOW, riversDir: rivers, settledDays: 0 });
    expect(existsSync(join(dir, 'v1/rivers'))).toBe(false);
    // The public tree holds no SPW station either.
    const owner = JSON.parse(readFileSync(join(dir, 'v1/stations.json'), 'utf8')) as { stations: { id: string }[] };
    expect(owner.stations.some((s) => s.id.startsWith('be.spw.'))).toBe(false);
  });
});
