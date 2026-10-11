import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANARY_RENDERINGS,
  FORECAST_FLAG_BITS,
  FORECAST_HORIZON_HOURS,
  LatestFile,
  StaticForecastLatest,
  StaticMeta,
  StaticStations,
} from '@rws/contracts';
import { StaticSources } from '@rws/contracts/static-owner';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writePayload } from '../../../../scripts/fixture-archive.ts';
import { publishTail } from '../../src/load/migrate.ts';
import { readRegistry, syncRegistry } from '../../src/load/registry-sync.ts';
import { type Harness, harness, KAUB_W } from '../load/harness.ts';
import { de2FlipRegistry } from './de2-flip.ts';
import { loadLobith } from './nl1.ts';
import { contract, walk } from './tree.ts';

// P12b (plan §3.2, §8 A11): the E1 flip simulated end to end. A database with settled public days and a DE-2 run on a
// DE-1 series is published; then the registry of the flip commit (DE-2 public, a test permissions/DE-2.md from the
// template) is synced, migrate's tail runs and the publisher runs again, as after the flip's deploy, whose image holds
// that registry (the server's REGISTRY_DIR points at the temp copy, and its modules are loaded afresh). Asserted:
// (a) every settled and frames file keeps its bytes, (b) no past day gets a new version (DE-2 has no series of its own,
// so the attribution digest of the day files is unchanged), (c) sources.json and forecast/latest.json gain DE-2 with
// the registry's exact credit, stations.json and the series hash do not change, (d) the owner canary and DE-3 (still
// owner, with the same credit text) are in no public file. Every value is generated.

const flip = vi.hoisted(() => ({ url: undefined as URL | undefined }));
vi.mock('../../src/capture/specs.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/capture/specs.ts')>();
  return {
    ...original,
    get REGISTRY_DIR() {
      return flip.url ?? original.REGISTRY_DIR;
    },
  };
});

const CREDIT = 'Wasserstandsvorhersage: Bundesanstalt für Gewässerkunde (BfG)';
const NOW = Date.parse('2026-10-04T12:00:00Z');
const HOUR = 3_600_000;
const KAUB = KAUB_W.slice(0, -'/W'.length);
let h: Harness;
let dir: string;
let registry: ReturnType<typeof de2FlipRegistry>;

/** A made-up DE-2 run: `n` two-hourly points from `init` (UTC), labelled at +02:00, an estimate after 48 h. */
function run(init: string, n: number): Buffer {
  const t0 = Date.parse(init);
  const label = (ms: number) => new Date(ms + 2 * HOUR).toISOString().replace('.000Z', '+02:00');
  return Buffer.from(
    JSON.stringify(
      Array.from({ length: n }, (_, i) => ({
        initialized: label(t0),
        timestamp: label(t0 + i * 2 * HOUR),
        value: 250 + i,
        type: i * 2 > 48 ? 'estimate' : 'forecast',
      })),
    ),
  );
}

/** One publisher run with modules loaded afresh, so every registry read (and its cache) sees REGISTRY_DIR now. */
async function publish(now: number): Promise<Map<string, string>> {
  vi.resetModules();
  const { publishOnce } = await import('../../src/publish/index.ts');
  const { RENDERERS } = await import('../../src/publish/render/index.ts');
  await publishOnce(h.dbAs('rws_publish', 3).db, 'public', dir, { now, render: RENDERERS });
  const files = walk(dir);
  for (const [rel, text] of files) contract('public', rel).parse(JSON.parse(text));
  return files;
}

const dayFiles = (files: Map<string, string>) =>
  new Map([...files].filter(([rel]) => rel.startsWith('settled/') || rel.startsWith('frames/')));
const json = (files: Map<string, string>, rel: string): unknown => JSON.parse(files.get(rel) ?? 'null');

beforeAll(async () => {
  h = await harness();
  await h.t.admin.query(`UPDATE app_meta SET value = '"2026-09-30T00:00:00Z"' WHERE key = 'display_start'`);
  await h.t.admin.query(`SELECT ensure_partitions('2026-09-01'::timestamptz, '2026-10-12'::timestamptz)`);
  dir = mkdtempSync(join(tmpdir(), 'rws-de2-flip-out-'));
  registry = de2FlipRegistry();
}, 120_000);
afterAll(async () => {
  flip.url = undefined;
  registry.remove();
  rmSync(dir, { recursive: true, force: true });
  await h.close();
});

describe('the DE-2 owner → public flip (P12b), simulated', { timeout: 300_000 }, () => {
  let before: Map<string, string>;

  it('before: settled days are rendered, and DE-2 (owner) is in no public file', async () => {
    // Each day loaded within 48 h of its start (the loader clock at the fetch), so no revision bumps it: v1 only.
    const at = (iso: string) => new Date(iso);
    await loadLobith(
      h,
      [[Date.parse('2026-09-30T12:00:00Z'), 101]],
      at('2026-10-01T10:00:00Z'),
      at('2026-10-01T10:00:00Z'),
    );
    await loadLobith(
      h,
      [[Date.parse('2026-10-01T12:00:00Z'), 102]],
      at('2026-10-02T10:00:00Z'),
      at('2026-10-02T10:00:00Z'),
    );
    await writePayload(h.archive, {
      source: 'DE-2',
      spec: 'de-2-wv',
      variant: KAUB,
      at: new Date('2026-10-02T05:12:00Z'),
      url: 'https://example.invalid/de-2-wv',
      body: run('2026-10-02T05:00:00Z', 49),
      retention: 'forever',
    });
    expect(await h.loader({ now: new Date(NOW) }).tick()).toEqual({ lines: 1, loaded: 1 });
    const runs = await h.t.admin.query(
      `SELECT r.source_id, s.source_id AS on_source FROM forecast_run r JOIN series s ON s.id = r.series_id`,
    );
    expect(runs.rows).toEqual([{ source_id: 'DE-2', on_source: 'DE-1' }]);

    const migrator = h.dbAs('rws_migrator', 1);
    await publishTail(migrator.db, new Date(NOW)); // the first tail only stores the visible registry
    await migrator.close();
    before = await publish(NOW);
    expect(
      [...dayFiles(before).keys()].filter((rel) => rel.startsWith('settled/')).map((r) => r.split('/')[1]),
    ).toEqual(expect.arrayContaining(['2026-09-30', '2026-10-01']));
    for (const [rel, text] of before) expect([rel, text.includes('"DE-2"')]).toEqual([rel, false]);
  });

  it('the flip: the registry sync and migrate’s tail bump no day', async () => {
    const migrator = h.dbAs('rws_migrator', 1);
    const read = readRegistry(registry.url);
    expect(read.sources.find((s) => s.id === 'DE-2')).toMatchObject({ audience: 'public', private_basis: null });
    expect(read.sources.find((s) => s.id === 'DE-2')?.attribution_text).toBe(CREDIT);
    await syncRegistry(migrator.db, read);
    expect(await publishTail(migrator.db, new Date(NOW + 60_000))).toMatchObject({ bumped: {}, schema: [] });
    await migrator.close();
    const versions = await h.t.admin.query("SELECT value FROM app_meta WHERE key = 'day_versions:public'");
    expect(versions.rows).toEqual([]);
  });

  it('after: (a) day files keep their bytes, (b) no new versions, (c) DE-2 credited, (d) no owner datum', async () => {
    flip.url = registry.url;
    const after = await publish(NOW + 60_000);
    // (a) + (b): exactly the same settled and frames files, byte for byte; meta names no new version.
    expect(dayFiles(after)).toEqual(dayFiles(before));
    expect(StaticMeta.parse(json(after, 'meta.json')).dayVersions).toEqual({});
    // stations.json and the series index are unchanged: DE-2 adds runs to DE-1 series, no series of its own.
    const stations = (files: Map<string, string>) => StaticStations.parse(json(files, 'stations.json'));
    expect(stations(after).stations).toEqual(stations(before).stations);
    expect(JSON.stringify(stations(after).attribution)).not.toContain('DE-2');
    const hash = (files: Map<string, string>) => LatestFile.parse(json(files, 'latest.json')).seriesHash;
    expect(hash(after)).toBe(hash(before));
    // (c) sources.json and forecast/latest.json: DE-2 with the registry's credit, verbatim.
    const sources = StaticSources.parse(json(after, 'sources.json'));
    expect(sources.sources.find((s) => s.id === 'DE-2')?.attribution).toEqual([
      expect.objectContaining({ text: CREDIT, required: true }),
    ]);
    expect(sources.attribution).toContainEqual(expect.objectContaining({ source: 'DE-2', text: CREDIT }));
    expect(StaticSources.parse(json(before, 'sources.json')).sources.map((s) => s.id)).not.toContain('DE-2');
    const forecast = StaticForecastLatest.parse(json(after, 'forecast/latest.json'));
    expect(forecast.runs.map((r) => r.source)).toEqual(['DE-2']);
    expect(forecast.attribution).toContainEqual(expect.objectContaining({ source: 'DE-2', text: CREDIT }));
    expect(StaticForecastLatest.parse(json(before, 'forecast/latest.json')).runs).toEqual([]);
    // (d) the owner canary, DE-3 and every other owner source stay out of every public file.
    const owner = registryOwnerIds();
    for (const [rel, text] of after) {
      for (const r of CANARY_RENDERINGS) expect([rel, text.includes(r)]).toEqual([rel, false]);
      for (const id of owner) expect([rel, id, text.includes(`"${id}"`)]).toEqual([rel, id, false]);
    }
  });

  it('DE-2 in public (synthetic): 48 to 96 h are estimates, the slider stays at 48 h, no WV run is no forecast', async () => {
    const after = walk(dir);
    const [de2] = StaticForecastLatest.parse(json(after, 'forecast/latest.json')).runs;
    if (de2 === undefined) throw new Error('no DE-2 run');
    // Only Kaub has a WV run: every other DE-1 series has no DE-2 forecast.
    expect(de2.series).toBe(await h.seriesId(KAUB_W));
    // A point more than 48 h after the issue time is an estimate (FORECAST_FLAG_BITS.estimate), none before it.
    const issued = Date.parse(de2.issuedAt);
    const estimate = de2.flags.map((f) => (f & FORECAST_FLAG_BITS.estimate) !== 0);
    expect(estimate).toEqual(de2.validTs.map((ts) => Date.parse(ts) - issued > FORECAST_HORIZON_HOURS * HOUR));
    expect(estimate.filter(Boolean)).toHaveLength(24);
    // The slider cap: /meta gives DE-2 the 48 h horizon of every forecast source, never its 96 h run.
    expect(FORECAST_HORIZON_HOURS).toBe(48);
    expect(StaticMeta.parse(json(after, 'meta.json')).forecastHorizons).toContainEqual({ source: 'DE-2', hours: 48 });
    // Monday after its 12:00 Berlin deadline without a newer WV run: the Friday run is superseded (C4), no forecast.
    const late = await publish(Date.parse('2026-10-05T10:30:00Z'));
    expect(StaticForecastLatest.parse(json(late, 'forecast/latest.json')).runs).toEqual([]);
  });
});

/** The owner-audience sources of the flipped registry (DE-3 and CANARY-OWNER among them, DE-2 no longer). */
function registryOwnerIds(): string[] {
  const ids = readRegistry(registry.url)
    .sources.filter((s) => s.audience === 'owner')
    .map((s) => s.id);
  expect(ids).toEqual(expect.arrayContaining(['DE-3', 'CANARY-OWNER']));
  expect(ids).not.toContain('DE-2');
  return ids;
}
