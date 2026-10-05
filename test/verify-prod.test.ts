import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Counters } from '../apps/server/src/capture/runner.ts';
import { cadenceOf, loadRegistry, REGISTRY_DIR, readSeed } from '../apps/server/src/capture/specs.ts';
import type { SpecState } from '../apps/server/src/capture/state.ts';
import { buildStatus, type CaptureStatus } from '../apps/server/src/capture/status.ts';
import { readRegistry } from '../apps/server/src/load/registry-sync.ts';
import type { OpsStatus } from '../apps/server/src/watchdog/watchdog.ts';
import {
  basemapAssetsPath,
  type ForecastCoverage,
  ForecastReaches,
  FramesFile,
  Health,
  HealthSources,
  Meta,
  type ReachesFile,
  type RiversManifest,
  Snapshot,
  Stations,
  validateBasemap,
  WarningsFile,
} from '../packages/contracts/src/index.ts';
import { TILE_FILE_RE, type TileFile, type TilesManifest } from '../packages/core/src/tiles-manifest.ts';
import {
  API_SOURCES,
  type ApiRead,
  BELGIAN_FRESH_PCT,
  BELGIAN_MAX_AGE_S,
  BELGIAN_NL1,
  belgianIds,
  CH4_NO_FORECAST,
  CHECKS,
  COVERAGE_MIN,
  capacity,
  ch4ExpectedSeries,
  checkApiParams,
  checkBelgianSet,
  checkBuild,
  checkBytes,
  checkCapture,
  checkClassCoverage,
  checkCoverage,
  checkForecastCh4,
  checkForecastCoverage,
  checkForecastNl1,
  checkFresh,
  checkHeaders,
  checkHealth,
  checkHealthParams,
  checkInterval,
  checkIntervalDe6,
  checkLabelOffset,
  checkLoaderLag,
  checkMapAsset,
  checkMeta,
  checkNoindex,
  checkOpenapi,
  checkOwnerHealth,
  checkOwnerIds,
  checkOwnerLeak,
  checkOwnerSources,
  checkOwnerStations,
  checkReplay,
  checkRiversAttribution,
  checkRiversDownload,
  checkRiversManifest,
  checkRiversReaches,
  checkRiversTiles,
  checkRuntimeConfig,
  checkSnapshot,
  checkSourceHealth,
  checkStates,
  checkStaticForecast,
  checkStaticFrames,
  checkStaticLag,
  checkStaticLatest,
  checkStaticMeta,
  checkStaticPrecompressed,
  checkStaticRecent,
  checkStaticRerender,
  checkStaticSeries,
  checkStaticSettled,
  checkStaticSources,
  checkStaticStations,
  checkStaticStatus,
  checkStaticWarnings,
  checkStations,
  checkTier1,
  checkTileFile,
  checkTiles404,
  checkTiles416,
  checkTilesManifestPage,
  checkTilesPrevious,
  checkTwin,
  DE7_BYTES_MAX,
  DE7_INTERVAL_MIN_S,
  DE7_SPEC,
  entryScript,
  expectedHeaders,
  FORECAST_CH4_MAX_AGE_S,
  FORECAST_NL1_CURRENT_MIN,
  FORECAST_NL1_MAX_AGE_S,
  FRESH_MAX_AGE_BY_SOURCE,
  FRESH_MAX_AGE_S,
  freshLimit,
  GEOJSON,
  INTERVAL_MIN_S,
  INTERVAL_SPEC,
  leaks,
  leakTerms,
  MANIFEST_CACHE,
  MAP_ASSET_PATH,
  META_CACHE,
  NOINDEX_PATHS,
  noIpv6Here,
  OPENAPI_CACHE,
  OpenApi31,
  OWNER_CANARY,
  OWNER_SOURCES_MIN,
  OWNER_STATION_PREFIXES,
  ownerKeys,
  ownerSourceIds,
  ownerStationIds,
  ownerTerms,
  PARAM_CASES,
  type Page,
  PMTILES_MAGIC,
  RERENDER_MAX_S,
  RIVERS_DOWNLOAD_RANGE,
  reachIds,
  readApi,
  readRiversManifest,
  readSnapshot,
  readStatic,
  readTilesManifest,
  recentCandidates,
  SNAPSHOT_ASKS,
  type SnapshotAsk,
  STATIC_CACHE,
  STATIC_LAG_MAX_S,
  STATIONS_CACHE,
  sampleCapture,
  settledAsk,
  snapshotAt,
  soak,
  staleSpecs,
  staticLeakTerms,
  TILE_416_REQUESTS,
  TILE_CACHE,
  TILE_HEADERS,
  TILES_404_PATHS,
  TWIN_IDS,
  tileFiles,
} from '../scripts/verify-prod.ts';
import { repoRoot } from './catalogue.ts';

// scripts/verify-prod.ts (issue #16 P1b build item 10): the pure checks. The
// network half runs against a real stack in the CI deploy job.

const architecture = readFileSync(join(repoRoot, 'docs/plan/ARCHITECTURE.md'), 'utf8');
const expected = expectedHeaders(architecture);
const registry = loadRegistry();
const NOW = new Date('2026-10-02T12:00:00Z');

describe('the A§12.2 headers', () => {
  it('reads the CSP and the other headers verbatim from ARCHITECTURE.md', () => {
    expect(expected['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests; report-to csp",
    );
    expect(expected).toMatchObject({
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'geolocation=(), camera=(), microphone=()',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'x-robots-tag': 'noindex',
    });
    expect(Object.keys(expected)).toHaveLength(8);
  });

  it('the Caddyfile sends exactly these values, removes Server and sends no CORS header', () => {
    const site = readFileSync(join(repoRoot, 'deploy/web/site.caddy'), 'utf8');
    const block = /\n\theader \{\n([\s\S]*?)\n\t\}/.exec(site)?.[1] ?? '';
    const sent: Record<string, string> = {};
    for (const [, name = '', value = ''] of block.matchAll(/^\t\t([A-Za-z-]+) "(.*)"$/gm))
      sent[name.toLowerCase()] = value;
    expect(sent).toEqual(expected);
    expect(block).toMatch(/^\t\t-Server$/m);
    expect(site.toLowerCase()).not.toContain('access-control-');
  });

  it('passes exact headers and names every difference', () => {
    expect(checkHeaders('/', 200, expected, expected).ok).toBe(true);
    const off = { ...expected, 'content-security-policy': `${expected['content-security-policy']} ` };
    expect(checkHeaders('/', 200, off, expected)).toMatchObject({ ok: false, detail: /content-security-policy/ });
    expect(checkHeaders('/', 200, { ...expected, 'access-control-allow-origin': '*' }, expected).detail).toMatch(
      /CORS/,
    );
    expect(checkHeaders('/', 200, { ...expected, server: 'Caddy' }, expected).detail).toMatch(/server/);
    expect(checkHeaders('/', 200, { ...expected, 'x-robots-tag': 'noindex, nofollow' }, expected).ok).toBe(false);
    expect(checkHeaders('/', 404, expected, expected).detail).toMatch(/status 404/);
  });
});

function statusCycle(): { pub: CaptureStatus; owner: CaptureStatus } {
  const states = new Map<string, SpecState>();
  const counters = new Counters();
  for (const s of registry.specs) {
    states.set(s.id, {
      enabled_since: '2026-10-01T00:00:00.000Z',
      last_attempt: '2026-10-02T11:59:00.000Z',
      last_success: '2026-10-02T11:59:30.000Z',
      last_failure_status: null,
      variants: {},
      seen: [],
      pending_page: [],
    });
    counters.record('2026-10-02', s.source, 'ok');
    counters.addBytes('2026-10-02', s.source, s.id, 1000);
  }
  const input = { registry, states, counters, seeds: [], nextDue: () => null, now: NOW };
  return { pub: buildStatus('public', input), owner: buildStatus('owner', input) };
}

describe('owner isolation in /status/*', () => {
  it('knows every owner source, spec and host from the registry, and the owner canary', () => {
    const terms = ownerTerms(registry);
    for (const t of [
      'BE-3',
      'LU-2',
      'LU-3',
      'LU-4',
      'DE-2',
      'DE-3',
      'lu-3-percentile',
      'be-3-values',
      'hydrometrie.wallonie.be',
      'inondations.public.lu',
      'vorhersage.bafg.de',
      OWNER_CANARY,
    ])
      expect(terms).toContain(t);
    for (const t of ['NL-1', 'CH-1', 'lu-1-csv']) expect(terms).not.toContain(t);
  });

  it('deploy/owner-terms.json, the status copy tripwire on the VPS, holds exactly these terms', () => {
    const file = JSON.parse(readFileSync(join(repoRoot, 'deploy/owner-terms.json'), 'utf8')) as { terms: string[] };
    expect(file.terms).toEqual(ownerTerms(registry));
    for (const t of file.terms) expect(t).toMatch(/^[A-Za-z0-9.-]{1,253}$/);
  });

  it('finds nothing in a real public capture.json, and every owner source in the owner one', () => {
    const { pub, owner } = statusCycle();
    expect(leaks(JSON.stringify(pub), ownerTerms(registry))).toEqual([]);
    expect(leaks(JSON.stringify(owner), ownerTerms(registry))).toEqual(
      expect.arrayContaining(['BE-3', 'LU-2', 'LU-3', 'LU-4', 'DE-2', 'DE-3']),
    );
  });

  it('matches whole identifiers only', () => {
    expect(leaks('{"source":"BE-3"}', ['BE-3'])).toEqual(['BE-3']);
    expect(leaks('{"source":"BE-30"}', ['BE-3'])).toEqual([]);
    expect(leaks('{"v":7777777.777}', [OWNER_CANARY])).toEqual([]);
    expect(leaks('{"v":777777.777}', [OWNER_CANARY])).toEqual([OWNER_CANARY]);
  });
});

describe('freshness, soak and capacity', () => {
  it('a spec is fresh only with a success within 3 × cadence_s', () => {
    const { pub } = statusCycle();
    const at = (s: string | null) =>
      ({ ...pub.specs[0], spec: 'x', cadence_s: 600, last_success: s }) as CaptureStatus['specs'][number];
    const status = {
      ...pub,
      specs: [
        at('2026-10-02T11:30:00Z'),
        { ...at('2026-10-02T11:29:59Z'), spec: 'y' },
        { ...at(null), spec: 'z', last_failure_status: 'dns' },
      ],
    };
    expect(staleSpecs(status, NOW)).toEqual(['y', 'z']);
  });

  it('a spec that has not run yet is n/a, not stale, unless it is overdue by more than 3 × cadence_s or never scheduled', () => {
    const { pub } = statusCycle();
    const never = (spec: string, next_due: string | null) =>
      ({
        ...pub.specs[0],
        spec,
        cadence_s: 86_400,
        last_success: null,
        last_failure_status: null,
        next_due,
      }) as CaptureStatus['specs'][number];
    const status = {
      ...pub,
      specs: [
        pub.specs[0] as CaptureStatus['specs'][number],
        never('daily', '2026-10-03T03:00:00Z'),
        never('overdue', '2026-09-28T03:00:00Z'),
        never('unscheduled', null),
      ],
    };
    expect(staleSpecs(status, NOW)).toEqual(['overdue', 'unscheduled']);
    const results = checkCapture({ ...status, specs: status.specs.slice(0, 2) }, NOW);
    expect(results.map((r) => [r.check, r.ok])).toEqual([
      ['freshness', true],
      ['freshness not run yet', 'n/a'],
      ['owner_specs', true],
    ]);
    expect(results[1]?.detail).toBe('due later: daily');
  });

  it('IPv6 is n/a only without a local route: EHOSTUNREACH (a server-side break) fails', () => {
    expect(noIpv6Here('ENETUNREACH')).toBe(true);
    expect(noIpv6Here('EADDRNOTAVAIL')).toBe(true);
    expect(noIpv6Here('EHOSTUNREACH')).toBe(false);
    expect(noIpv6Here('ECONNREFUSED')).toBe(false);
  });

  const day = (
    date: string,
    source: string,
    ok: number,
    fails: Partial<Record<'upstream_5xx' | 'timeouts' | 'other', number>>,
  ) => {
    const f = { upstream_5xx: 0, timeouts: 0, other: 0, ...fails };
    return {
      source,
      date,
      scheduled: ok + f.upstream_5xx + f.timeouts + f.other,
      ok,
      ...f,
      bytes: { [`${source.toLowerCase()}-x`]: 1e6 },
    };
  };
  const ops = (drill: OpsStatus['drill']): OpsStatus => ({
    generated_at: NOW.toISOString(),
    last_backup: null,
    drill,
    disk_pct: 40,
  });

  it('soak: >= 99% per source, the seed coverage and the drill', () => {
    const { pub } = statusCycle();
    const status = {
      ...pub,
      days: [day('2026-10-01', 'NL-1', 995, { upstream_5xx: 5 }), day('2026-10-01', 'FR-1', 97, { timeouts: 3 })],
      seeds: [
        { spec: 'de-1-series', series: 60, days_covered: 29.5, files: 60, done_at: NOW.toISOString() },
        { spec: 'lu-5-cap', series: 1, days_covered: 400, files: 832, done_at: NOW.toISOString() },
      ],
    };
    const { results } = soak(status, ops({ at: NOW.toISOString(), sampled: 100, matched: 100 }));
    const by = Object.fromEntries(results.map((r) => [r.check, r.ok]));
    expect(by).toMatchObject({
      'soak NL-1': true,
      'soak FR-1': false,
      'seed de-1-series': true,
      'seed lu-5-cap': false,
      'seed fr-1-obs': false,
      'restore drill': true,
    });
    expect(soak(status, ops({ at: NOW.toISOString(), sampled: 100, matched: 99 })).results.at(-1)?.ok).toBe(false);
  });

  it('capacity needs two complete UTC days and projects the year against the disk and the bucket', () => {
    const { pub } = statusCycle();
    const oneDay = { ...pub, days: [day('2026-10-01', 'NL-1', 1, {})] };
    expect(capacity(oneDay, registry, '2026-10-02', null).ok).toBe(false);
    const twoDays = {
      ...pub,
      days: ['2026-09-30', '2026-10-01', '2026-10-02'].map((date) => ({
        ...day(date, 'NL-1', 1, {}),
        bytes: { 'nl-1-obs-key': 2e6, 'nl-1-fc-1h': 1e6 },
      })),
    };
    const c = capacity(twoDays, registry, '2026-10-02', 5e6);
    expect(c.ok).toBe(true);
    expect(c.markdown).toContain('from 2 complete UTC days of production capture (2026-09-30 to 2026-10-01)');
    expect(c.markdown).toMatch(/\| NL-1 \| nl-1-obs-key \| obs \| 2000000 \| 0\.180 \|/);
    expect(c.markdown).toMatch(/\| NL-1 \| nl-1-fc-1h \| forever \| 1000000 \| 0\.365 \|/);
    expect(c.markdown).toContain('| owner (aggregate) |');
    expect(c.markdown).not.toMatch(/BE-3|LU-2|lu-3-percentile/);
  });

  it('verify-prod.sh --dry-run lists the checks without touching the network', () => {
    const r = spawnSync(join(repoRoot, 'scripts/verify-prod.sh'), ['--dry-run', 'x'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^headers \/ and \/en\/:/m);
    for (const name of [
      'health',
      'health params',
      'health DE-1',
      'tier-1 DE-1',
      'loader lag',
      'replay DE-1',
      'health NL-1',
      'tier-1 NL-1',
      'replay NL-1',
      'health FR-1',
      'tier-1 FR-1',
      'coverage FR-1',
      'health CH-1',
      'tier-1 CH-1',
      'coverage CH-1',
      'health DE-7',
      'tier-1 DE-7',
      'coverage DE-7',
      'health LU-1',
      'tier-1 LU-1',
      'coverage LU-1',
      'interval CH-1',
      'interval DE-7',
      'bytes DE-7',
      'api meta',
      'api build',
      'api stations',
      'api snapshot now',
      'api snapshot 6h',
      'api snapshot 3d',
      'api states',
      'class coverage',
      'forecast NL-1',
      'forecast CH-4',
      'forecast coverage',
      'api openapi',
      'api params',
      'noindex',
      'fresh DE-1',
      'fresh NL-1',
      'fresh FR-1',
      'fresh CH-1',
      'fresh DE-7',
      'fresh LU-1',
      'label offset LU-1',
      'belgian set',
      'owner sources',
      'owner health',
      'owner stations',
      'owner leak',
      'tiles manifest',
      'tiles <file>',
      'tiles previous',
      'tiles 404',
      'map assets',
      'rivers manifest',
      'rivers tiles',
      'rivers reaches',
      'rivers download',
      'rivers attribution',
      ...TWIN_IDS.map((id) => `twin ${id}`),
    ])
      expect(r.stdout, name).toMatch(new RegExp(`^${name}:`, 'm'));
  });
});

// The P2a health checks (issue P2a [agent-prod] criteria): pure, on contract documents.

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const health = (over: Partial<Health> = {}): Health => ({
  status: 'ok',
  generated_at: ago(60_000),
  loader: {
    lag_p95_s: 34,
    backlog_files: 0,
    backlog_bytes: 0,
    backlog_age_s: null,
    bad_manifest_lines: 0,
    last_commit: null,
  },
  sources: { ok: 10, degraded: 0, down: 0, unknown: 2, total: 12 },
  owner_sources: { healthy: 5, total: 6 },
  quarantined: 0,
  twins: { ok: 0, failing: 0 },
  ...over,
});
type SourceRow = HealthSources['sources'][number];
const de1 = (over: Partial<SourceRow> = {}): SourceRow => ({
  id: 'DE-1',
  status: 'ok',
  last_fetch_ok: ago(60_000),
  last_new_data: ago(60_000),
  newest_ts: ago(120_000),
  consecutive_failures: 0,
  quarantined: 0,
  lag_p95_s: 34,
  tier1: { total: 69, fresh: 69, provider_stale: 0 },
  missing_buckets_24h: 3,
  outage: null,
  coverage: null,
  min_interval_s: [],
  label_offset: null,
  forecast: null,
  partitions: [{ partition: '2026-10', md5: 'a'.repeat(32), rows: 9000 }],
  partitions_at: ago(60_000),
  ...over,
});
const nl1 = (over: Partial<SourceRow> = {}): SourceRow =>
  de1({ id: 'NL-1', tier1: { total: 40, fresh: 40, provider_stale: 0 }, ...over });
const sourcesDoc = (over: Partial<HealthSources> = {}): HealthSources => ({
  generated_at: ago(60_000),
  sources: [de1()],
  quarantined_batches: [],
  twins: [],
  owner_sources: { healthy: 5, total: 6 },
  classification: null,
  forecast_coverage: null,
  ...over,
});
const page = (doc: unknown, over: Partial<Page> = {}): Page => ({
  status: 200,
  headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' },
  body: typeof doc === 'string' ? doc : JSON.stringify(doc),
  ...over,
});
const h = (doc: Health = health(), over: Partial<Page> = {}) => readApi(page(doc, over), Health);
const s = (doc: HealthSources = sourcesDoc(), over: Partial<Page> = {}) => readApi(page(doc, over), HealthSources);

describe('the health API answers', () => {
  it('readApi: the contract document with 200, JSON and max-age=30', () => {
    expect(h()).toMatchObject({ data: { status: 'ok' }, problems: [] });
    expect(
      readApi(
        page(health(), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=30' } }),
        Health,
      ).problems,
    ).toEqual([]);
  });

  it('readApi: names every difference and still returns the document when only a header is off', () => {
    const wrongCache = h(health(), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    });
    expect(wrongCache.problems).toEqual(['cache-control "public, max-age=300"']);
    expect(wrongCache.data).toBeDefined();
    expect(h(health(), { status: 503 }).problems).toContain('status 503');
    expect(h(health(), { headers: {} }).problems).toHaveLength(2);
    expect(readApi(page('<html>'), Health)).toEqual({ problems: ['not the contract document'] });
    expect(readApi(page({ ...health(), version: '1' }), Health).data).toBeUndefined();
    expect(readApi('ECONNRESET', Health)).toEqual({ problems: ['ECONNRESET'] });
  });

  it('health: passes for a computing loader, fails for down, off-contract or unreachable', () => {
    expect(checkHealth(h())).toMatchObject({ check: 'health', ok: true });
    expect(checkHealth(h(health({ status: 'degraded', quarantined: 2 })))).toMatchObject({ ok: true });
    const down = checkHealth(h(health({ status: 'down', generated_at: null })));
    expect(down).toMatchObject({ ok: false, detail: /status down \(generated_at never\)/ });
    expect(checkHealth(readApi(page('{}'), Health))).toMatchObject({ ok: false, detail: /contract/ });
    expect(checkHealth(readApi('timeout', Health))).toMatchObject({ ok: false, detail: 'timeout' });
    expect(checkHealth(h(health(), { status: 404 })).ok).toBe(false);
  });

  it("health params: a parameter is the fixed 400 and an unknown path is the api's fixed 404", () => {
    const good: Record<string, Page | string> = Object.fromEntries(
      PARAM_CASES.map(([path, status]) => [
        path,
        page(status === 400 ? '{"error":"unknown_parameter"}' : '{"error":"not_found"}', { status }),
      ]),
    );
    expect(checkHealthParams(good)).toMatchObject({ check: 'health params', ok: true });
    const bad = checkHealthParams({
      ...good,
      '/api/v1/health?x=1': page('{"health":1}', { status: 200 }),
      '/api/v1/health/sources?x=1': page('{"error":"unknown_parameter","x":"1"}', { status: 400 }),
      '/api/v1/x': page('[]', { status: 200 }),
      '/api/v1/': 'ECONNRESET',
    });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/health\?x=1: status 200, want 400/);
    expect(bad.detail).toMatch(/sources\?x=1: the body is not the fixed 400 body/);
    expect(bad.detail).toMatch(/\/api\/v1\/x: status 200, want 404/);
    expect(bad.detail).toMatch(/\/api\/v1\/: ECONNRESET/);
    expect(checkHealthParams({}).ok).toBe(false);
  });

  it('health DE-1: listed with status ok', () => {
    expect(checkSourceHealth(s())).toMatchObject({ check: 'health DE-1', ok: true });
    expect(checkSourceHealth(s(sourcesDoc({ sources: [de1({ status: 'degraded', quarantined: 1 })] })))).toMatchObject({
      ok: false,
      detail: /status degraded \(0 failed fetches in a row, 1 quarantined\)/,
    });
    expect(checkSourceHealth(s(sourcesDoc({ sources: [de1({ id: 'DE-4' })] })))).toMatchObject({
      ok: false,
      detail: /not listed/,
    });
    expect(checkSourceHealth(readApi('timeout', HealthSources))).toMatchObject({ ok: false, detail: /timeout/ });
  });

  const tier1 = (total: number, fresh: number, provider_stale: number) =>
    sourcesDoc({ sources: [de1({ tier1: { total, fresh, provider_stale } })] });

  it('tier-1 DE-1: PASS at 95% fresh; FAIL below it, naming exactly how many are provider-stale', () => {
    expect(checkTier1(tier1(69, 66, 0))).toMatchObject({ check: 'tier-1 DE-1', ok: true, detail: /66 of 69/ });
    expect(checkTier1(tier1(20, 19, 0)).ok).toBe(true);
    // 64 of 69 fresh is 92.8%: the five provider-stale series make 100%, which the owner judges; never a PASS.
    const low = checkTier1(tier1(69, 64, 5));
    expect(low.ok).toBe(false);
    expect(low.detail).toContain('64 of 69 tier-1 series fresh (92.8%)');
    expect(low.detail).toContain('5 are provider-stale');
    expect(low.detail).toContain('with them 69 of 69');
    // Stale for another reason than the provider: plain FAIL, no such hint.
    const bad = checkTier1(tier1(69, 30, 0));
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('0 are provider-stale');
    expect(bad.detail).not.toContain('for the owner to judge');
    expect(checkTier1(sourcesDoc({ sources: [de1({ tier1: null })] }))).toMatchObject({
      ok: false,
      detail: /no tier-1 numbers/,
    });
    expect(checkTier1(tier1(0, 0, 0)).ok).toBe(false);
    expect(checkTier1(undefined)).toMatchObject({ ok: false, detail: /no valid health\/sources document/ });
  });

  it('loader lag: a sample, and under 120 s', () => {
    const lag = (lag_p95_s: number | null) => checkLoaderLag(health({ loader: { ...health().loader, lag_p95_s } }));
    expect(lag(34)).toMatchObject({ check: 'loader lag', ok: true });
    expect(lag(119.9).ok).toBe(true);
    expect(lag(120).ok).toBe(false);
    expect(lag(null)).toMatchObject({ ok: false, detail: /no lag sample/ });
    expect(checkLoaderLag(undefined).ok).toBe(false);
  });

  it('loader lag fails on a stall: a manifest line unconsumed for 15 minutes, even with a good lag sample', () => {
    const age = (backlog_age_s: number | null) =>
      checkLoaderLag(health({ loader: { ...health().loader, backlog_files: 1, backlog_bytes: 812, backlog_age_s } }));
    expect(age(899).ok).toBe(true);
    expect(age(900)).toMatchObject({ ok: false, detail: /stalled: the oldest unconsumed manifest line is 900 s old/ });
    expect(age(null).ok).toBe(true);
  });

  it('replay DE-1: no backlog, a partition checksum, nothing quarantined; lists the quarantined batches', () => {
    expect(checkReplay(health(), sourcesDoc())).toMatchObject({
      check: 'replay DE-1',
      ok: true,
      detail: /1 partition checksums \(2026-10\)/,
    });
    const backlog = health({ loader: { ...health().loader, backlog_files: 2, backlog_bytes: 4096 } });
    expect(checkReplay(backlog, sourcesDoc()).detail).toBe('loader backlog 4096 bytes in 2 files');
    expect(checkReplay(health(), sourcesDoc({ sources: [de1({ partitions: [] })] })).detail).toBe(
      'no partition checksum',
    );
    const quarantined = sourcesDoc({
      sources: [de1({ quarantined: 2 })],
      quarantined_batches: [
        { id: '41', source: 'DE-1', spec: 'de-1-basin', fetched_at: ago(1000), error: 'unrecognized_keys' },
        { id: '40', source: 'NL-1', spec: 'nl-1-obs-key', fetched_at: ago(2000), error: 'other_source' },
        { id: '39', source: 'DE-1', spec: 'de-1-series', fetched_at: ago(3000), error: null },
      ],
    });
    const r = checkReplay(health(), quarantined);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('2 quarantined (newest: 41 unrecognized_keys, 39 no code)');
    expect(checkReplay(undefined, sourcesDoc()).ok).toBe(false);
    expect(checkReplay(health(), undefined).ok).toBe(false);
  });

  // NL-1 (P2b): the same three checks, each on its own source's numbers and under its own name.
  const both = (over: Partial<SourceRow> = {}, de1Over: Partial<SourceRow> = {}) =>
    sourcesDoc({ sources: [de1(de1Over), nl1(over)] });

  it('health NL-1: its own name and its own status; DE-1 in the same document does not count', () => {
    expect(checkSourceHealth(s(both()), 'NL-1')).toMatchObject({ check: 'health NL-1', ok: true });
    expect(checkSourceHealth(s(both({}, { status: 'down' })), 'NL-1').ok).toBe(true);
    expect(checkSourceHealth(s(both({ status: 'degraded', consecutive_failures: 3, quarantined: 1 })), 'NL-1')).toEqual(
      {
        check: 'health NL-1',
        ok: false,
        detail: 'status degraded (3 failed fetches in a row, 1 quarantined)',
      },
    );
    expect(checkSourceHealth(s(), 'NL-1')).toMatchObject({ check: 'health NL-1', ok: false, detail: /not listed/ });
    expect(checkSourceHealth(readApi('timeout', HealthSources), 'NL-1')).toMatchObject({
      check: 'health NL-1',
      ok: false,
      detail: /timeout/,
    });
  });

  it('tier-1 NL-1: 95% of the tier-1 series of NL-1, whatever DE-1 has', () => {
    const at = (total: number, fresh: number, provider_stale: number) =>
      both({ tier1: { total, fresh, provider_stale } }, { tier1: { total: 69, fresh: 0, provider_stale: 0 } });
    expect(checkTier1(at(40, 38, 0), 'NL-1')).toMatchObject({ check: 'tier-1 NL-1', ok: true, detail: /38 of 40/ });
    expect(checkTier1(at(40, 38, 0)).ok).toBe(false);
    const low = checkTier1(at(40, 36, 4), 'NL-1');
    expect(low).toMatchObject({ check: 'tier-1 NL-1', ok: false });
    expect(low.detail).toContain('36 of 40 tier-1 series fresh (90.0%)');
    expect(low.detail).toContain('with them 40 of 40, for the owner to judge');
    expect(checkTier1(at(40, 20, 0), 'NL-1').detail).not.toContain('for the owner to judge');
    expect(checkTier1(sourcesDoc(), 'NL-1')).toMatchObject({ ok: false, detail: /no tier-1 numbers/ });
    expect(checkTier1(undefined, 'NL-1')).toMatchObject({ check: 'tier-1 NL-1', ok: false });
  });

  it('replay NL-1: its own partitions and its own quarantined batches', () => {
    expect(checkReplay(health(), both(), 'NL-1')).toMatchObject({ check: 'replay NL-1', ok: true });
    expect(checkReplay(health(), both({ partitions: [] }), 'NL-1').detail).toBe('no partition checksum');
    const batches = [
      { id: '41', source: 'DE-1', spec: 'de-1-basin', fetched_at: ago(1000), error: 'unrecognized_keys' },
      { id: '40', source: 'NL-1', spec: 'nl-1-obs-key', fetched_at: ago(2000), error: 'invalid_value' },
    ];
    expect(
      checkReplay(health(), { ...both({ quarantined: 1 }, { quarantined: 2 }), quarantined_batches: batches }, 'NL-1'),
    ).toEqual({
      check: 'replay NL-1',
      ok: false,
      detail: '1 quarantined (newest: 40 invalid_value)',
    });
    // DE-1 is quarantined too, but NL-1 alone is not.
    expect(checkReplay(health(), { ...both({}, { quarantined: 2 }), quarantined_batches: batches }, 'NL-1').ok).toBe(
      true,
    );
    expect(checkReplay(health(), sourcesDoc(), 'NL-1')).toMatchObject({ ok: false, detail: /not listed/ });
  });
});

// P5a: FR-1 and CH-1 get the same health and tier-1 checks as DE-1 and NL-1, plus the coverage since the seed and
// (CH-1 only) the request interval BAFU asks for.

describe('FR-1 and CH-1 health, tier-1, coverage and interval', () => {
  const fr1 = (over: Partial<SourceRow> = {}) =>
    de1({ id: 'FR-1', tier1: { total: 39, fresh: 39, provider_stale: 0 }, ...over });
  const ch1 = (over: Partial<SourceRow> = {}) =>
    de1({ id: 'CH-1', tier1: { total: 17, fresh: 17, provider_stale: 0 }, ...over });
  const day = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
  const coverage = (over: Partial<NonNullable<SourceRow['coverage']>> = {}): NonNullable<SourceRow['coverage']> => ({
    from: '2026-09-02T00:00:00.000Z',
    ratio: 0.987,
    series: 39,
    series_below_95: 2,
    gaps: [{ from: day(30), to: day(29) }],
    ...over,
  });
  const interval = (seconds: number, spec = INTERVAL_SPEC) => ({ spec, seconds });
  const all = (over: Partial<HealthSources> = {}) =>
    sourcesDoc({ sources: [de1(), nl1(), fr1({ coverage: coverage() }), ch1({ coverage: coverage() })], ...over });

  it('the builders are documents of the strict contract, with the two new fields', () => {
    const doc = s(all()).data;
    expect(doc?.sources.map((x) => x.id)).toEqual(['DE-1', 'NL-1', 'FR-1', 'CH-1']);
    expect(doc?.sources[2]?.coverage?.series).toBe(39);
    expect(s(sourcesDoc({ sources: [fr1({ coverage: coverage({ ratio: 1.01 }) })] })).data).toBeUndefined();
    expect(
      s(sourcesDoc({ sources: [fr1({ min_interval_s: [{ spec: 'Bad Spec', seconds: 600 }] })] })).data,
    ).toBeUndefined();
    expect(s(sourcesDoc({ sources: [fr1({ coverage: undefined as never })] })).data).toBeUndefined();
  });

  it('health FR-1 and health CH-1: each its own name and its own status', () => {
    expect(checkSourceHealth(s(all()), 'FR-1')).toMatchObject({ check: 'health FR-1', ok: true });
    expect(checkSourceHealth(s(all()), 'CH-1')).toMatchObject({ check: 'health CH-1', ok: true });
    const down = sourcesDoc({ sources: [de1(), nl1(), fr1({ status: 'down', consecutive_failures: 4 }), ch1()] });
    expect(checkSourceHealth(s(down), 'FR-1')).toEqual({
      check: 'health FR-1',
      ok: false,
      detail: 'status down (4 failed fetches in a row, 0 quarantined)',
    });
    expect(checkSourceHealth(s(down), 'CH-1').ok).toBe(true);
    expect(checkSourceHealth(s(), 'CH-1')).toMatchObject({ ok: false, detail: /not listed/ });
  });

  it('tier-1 FR-1 and tier-1 CH-1: 95% of their own series', () => {
    const at = (id: 'FR-1' | 'CH-1', total: number, fresh: number) =>
      sourcesDoc({ sources: [de1(), (id === 'FR-1' ? fr1 : ch1)({ tier1: { total, fresh, provider_stale: 0 } })] });
    expect(checkTier1(at('FR-1', 39, 38), 'FR-1')).toMatchObject({
      check: 'tier-1 FR-1',
      ok: true,
      detail: /38 of 39/,
    });
    expect(checkTier1(at('CH-1', 17, 17), 'CH-1')).toMatchObject({ check: 'tier-1 CH-1', ok: true });
    // With 17 tier-1 series one stale series is already below 95%.
    expect(checkTier1(at('CH-1', 17, 16), 'CH-1')).toMatchObject({
      ok: false,
      detail: /16 of 17 tier-1 series fresh \(94\.1%\)/,
    });
    expect(checkTier1(at('CH-1', 17, 17), 'FR-1')).toMatchObject({ ok: false, detail: /no tier-1 numbers/ });
  });

  it('coverage: PASS from 95%, with the ratio, the series below 95%, the first instant, the gaps and the newest gap', () => {
    expect(COVERAGE_MIN).toBe(0.95);
    const gaps = [
      { from: day(30), to: day(29) },
      { from: day(10), to: day(9) },
      { from: day(50), to: day(48) },
    ];
    const doc = s(sourcesDoc({ sources: [fr1({ coverage: coverage({ gaps }) })] })).data;
    expect(checkCoverage(doc, 'FR-1')).toEqual({
      check: 'coverage FR-1',
      ok: true,
      detail: `98.7% of the expected buckets since 2026-09-02T00:00:00.000Z, 2 of 39 tier-1 series below 95%, 3 gaps, the newest from ${day(10)} to ${day(9)}`,
    });
    expect(checkCoverage(s(all()).data, 'CH-1')).toMatchObject({ check: 'coverage CH-1', ok: true });
  });

  it('coverage: 95% is the boundary, and a source without gaps names none', () => {
    const at = (ratio: number, gaps: { from: string; to: string }[] = []) =>
      checkCoverage(s(sourcesDoc({ sources: [fr1({ coverage: coverage({ ratio, gaps }) })] })).data, 'FR-1');
    expect(at(1)).toMatchObject({ ok: true, detail: expect.stringMatching(/^100\.0% .*, 0 gaps$/) });
    expect(at(0.95).ok).toBe(true);
    const low = at(0.9499, [{ from: day(5), to: day(4) }]);
    expect(low.ok).toBe(false);
    expect(low.detail).toMatch(/^95\.0% of the expected buckets/);
    expect(low.detail).toMatch(/1 gaps, the newest from .* to .*; below 95%$/);
    expect(at(0.5)).toMatchObject({ ok: false, detail: expect.stringContaining('50.0%') });
    expect(at(0).ok).toBe(false);
  });

  it('coverage: no coverage yet, a source that is not listed and no document are FAILs', () => {
    expect(checkCoverage(s(all()).data, 'DE-1')).toEqual({
      check: 'coverage DE-1',
      ok: false,
      detail: 'no coverage yet',
    });
    expect(checkCoverage(s(all()).data, 'FR-3')).toMatchObject({ ok: false, detail: /not listed/ });
    expect(checkCoverage(undefined, 'CH-1')).toMatchObject({
      check: 'coverage CH-1',
      ok: false,
      detail: /no valid health\/sources document/,
    });
  });

  it('coverage prints only numbers and instants: a hostile source id in the same document never appears', () => {
    const doc = s(sourcesDoc({ sources: [fr1({ coverage: coverage() })], quarantined_batches: [] })).data;
    expect(checkCoverage(doc, 'FR-1').detail).toMatch(/^[0-9A-Za-z .,%:-]+$/);
  });

  it('interval: the BAFU rule is 600 s, the check allows 5 s of scheduling jitter', () => {
    expect([INTERVAL_SPEC, INTERVAL_MIN_S]).toEqual(['ch-1-lindas', 595]);
    const spec = registry.specs.find((x) => x.id === INTERVAL_SPEC);
    expect(spec?.source).toBe('CH-1');
    expect(cadenceOf(spec?.cron ?? '')).toBeGreaterThanOrEqual(INTERVAL_MIN_S + 5);
    const at = (...entries: { spec: string; seconds: number }[]) =>
      checkInterval(s(sourcesDoc({ sources: [ch1({ min_interval_s: entries })] })).data);
    expect(at(interval(600))).toEqual({
      check: 'interval CH-1',
      ok: true,
      detail: 'ch-1-lindas: the shortest gap between two requests of one variant in 24 h is 600 s, not under 595 s',
    });
    expect(at(interval(595)).ok).toBe(true);
    expect(at(interval(594))).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/is 594 s, under 595 s \(BAFU: at most one download per 10 minutes\)$/),
    });
    expect(at(interval(0)).ok).toBe(false);
    // Only the entry of the LINDAS spec counts; another spec's short gap does not.
    expect(at(interval(10, 'ch-2-pq'), interval(600)).ok).toBe(true);
    expect(at(interval(10, 'ch-2-pq'))).toEqual({
      check: 'interval CH-1',
      ok: false,
      detail: 'no interval measured yet',
    });
    expect(at()).toMatchObject({ ok: false, detail: 'no interval measured yet' });
  });

  it('interval: a source that is not listed, and no document, are FAILs', () => {
    expect(checkInterval(s(sourcesDoc({ sources: [de1()] })).data)).toMatchObject({
      check: 'interval CH-1',
      ok: false,
      detail: /not listed/,
    });
    expect(checkInterval(undefined)).toMatchObject({ ok: false, detail: /no valid health\/sources document/ });
  });

  it('the --dry-run list states the new rules', () => {
    const one = (name: string) => {
      const found = CHECKS.filter((c) => c.startsWith(`${name}:`));
      expect(found, name).toHaveLength(1);
      return found[0] ?? '';
    };
    expect(one('coverage FR-1')).toContain('95%');
    expect(one('coverage CH-1')).toContain('null is a FAIL');
    expect(one('interval CH-1')).toMatch(/>= 595 s.*BAFU.*10 minutes.*5 s/);
    for (const name of ['health FR-1', 'health CH-1', 'tier-1 FR-1', 'tier-1 CH-1']) one(name);
  });
});

// P5b: DE-7 (LANUK NRW) and LU-1 (AGE) join the per-source checks; their own rules: DE-7's 15-minute interval and
// bytes per day, LU-1's label offset, and slower freshness limits.

describe('DE-7 and LU-1 health, tier-1, coverage, interval, bytes and label offset', () => {
  const de7 = (over: Partial<SourceRow> = {}) =>
    de1({ id: 'DE-7', tier1: { total: 120, fresh: 120, provider_stale: 0 }, ...over });
  const lu1 = (over: Partial<SourceRow> = {}) =>
    de1({ id: 'LU-1', tier1: { total: 20, fresh: 20, provider_stale: 0 }, ...over });
  const offset = (over: Partial<NonNullable<SourceRow['label_offset']>> = {}) => ({
    day: '2026-10-01',
    decided: true,
    n_aligned: 34,
    share: 0.978,
    minutes: 15,
    decided_day: '2026-10-01',
    ...over,
  });
  const cover = { from: '2026-09-02T00:00:00.000Z', ratio: 0.99, series: 120, series_below_95: 1, gaps: [] };
  const NOW_ISO = NOW.toISOString();

  it('health, tier-1 and coverage: each source its own, by name', () => {
    const doc = s(sourcesDoc({ sources: [de1(), de7({ coverage: cover }), lu1({ status: 'degraded' })] }));
    expect(checkSourceHealth(doc, 'DE-7')).toMatchObject({ check: 'health DE-7', ok: true });
    expect(checkSourceHealth(doc, 'LU-1')).toMatchObject({
      check: 'health LU-1',
      ok: false,
      detail: /status degraded/,
    });
    expect(checkTier1(doc.data, 'DE-7')).toMatchObject({ check: 'tier-1 DE-7', ok: true, detail: /120 of 120/ });
    expect(checkTier1(doc.data, 'LU-1')).toMatchObject({ check: 'tier-1 LU-1', ok: true, detail: /20 of 20/ });
    expect(checkCoverage(doc.data, 'DE-7')).toMatchObject({ check: 'coverage DE-7', ok: true });
    expect(checkCoverage(doc.data, 'LU-1')).toMatchObject({
      check: 'coverage LU-1',
      ok: false,
      detail: 'no coverage yet',
    });
    expect(checkSourceHealth(s(), 'DE-7')).toMatchObject({ ok: false, detail: /not listed/ });
  });

  it('interval DE-7: 895 s is the least gap (15 minutes less 5 s), the detail says the seconds', () => {
    expect([DE7_SPEC, DE7_INTERVAL_MIN_S]).toEqual(['de-7-messwerte', 895]);
    const spec = registry.specs.find((x) => x.id === DE7_SPEC);
    expect(spec?.source).toBe('DE-7');
    expect(cadenceOf(spec?.cron ?? '')).toBeGreaterThanOrEqual(DE7_INTERVAL_MIN_S + 5);
    const at = (...entries: { spec: string; seconds: number }[]) =>
      checkInterval(s(sourcesDoc({ sources: [de7({ min_interval_s: entries })] })).data, 'DE-7');
    // Hourly today: 3600 s passes, and the owner reads it.
    expect(at({ spec: DE7_SPEC, seconds: 3600 })).toEqual({
      check: 'interval DE-7',
      ok: true,
      detail: 'de-7-messwerte: the shortest gap between two requests of one variant in 24 h is 3600 s, not under 895 s',
    });
    expect(at({ spec: DE7_SPEC, seconds: 900 }).ok).toBe(true);
    expect(at({ spec: DE7_SPEC, seconds: 895 }).ok).toBe(true);
    expect(at({ spec: DE7_SPEC, seconds: 894 })).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/is 894 s, under 895 s \(requested more often than every 15 minutes\)$/),
    });
    expect(at({ spec: 'de-7-pegeldaten', seconds: 60 }, { spec: DE7_SPEC, seconds: 900 }).ok).toBe(true);
    expect(at({ spec: 'de-7-pegeldaten', seconds: 900 })).toMatchObject({
      ok: false,
      detail: 'no interval measured yet',
    });
    expect(checkInterval(s(sourcesDoc({ sources: [de1()] })).data, 'DE-7')).toMatchObject({
      ok: false,
      detail: /not listed/,
    });
    expect(checkInterval(undefined, 'DE-7')).toMatchObject({ check: 'interval DE-7', ok: false });
    // CH-1 stays the default, with its own rule.
    expect(checkInterval(s(sourcesDoc({ sources: [de1()] })).data).check).toBe('interval CH-1');
  });

  it('bytes DE-7: a day over 90 MB fails, the biggest of the days is named, the spec must be in capture.json', () => {
    expect(DE7_BYTES_MAX).toBe(90_000_000);
    const { pub } = statusCycle();
    const withBytes = (bytes: Record<string, number>): CaptureStatus => ({
      ...pub,
      days: pub.days.map((d) =>
        d.source === 'DE-7' && d.date === '2026-10-02' ? { ...d, bytes: { ...d.bytes, ...bytes } } : d,
      ),
    });
    expect(checkBytes(pub)).toEqual({
      check: 'bytes DE-7',
      ok: true,
      detail: 'de-7-messwerte: at most 1000 bytes on 2026-10-02 (1 day(s) with bytes), not over 90000000',
    });
    // 96 fetches of the 0.9 MB ZIP at 15 minutes fit; one day over the limit does not.
    expect(checkBytes(withBytes({ [DE7_SPEC]: 90_000_000 })).ok).toBe(true);
    expect(checkBytes(withBytes({ [DE7_SPEC]: 90_000_001 }))).toMatchObject({
      ok: false,
      detail: 'de-7-messwerte: at most 90000001 bytes on 2026-10-02 (1 day(s) with bytes), over 90000000',
    });
    expect(checkBytes({ ...pub, specs: pub.specs.filter((x) => x.spec !== DE7_SPEC) })).toMatchObject({
      ok: false,
      detail: 'de-7-messwerte is not in capture.json',
    });
    expect(checkBytes({ ...pub, days: pub.days.map((d) => ({ ...d, bytes: {} })) })).toMatchObject({
      ok: false,
      detail: expect.stringContaining('no bytes of de-7-messwerte'),
    });
  });

  it('label offset LU-1: a day no older than 2 days before meta.now, any offset, numbers and a date only', () => {
    const at = (label_offset: SourceRow['label_offset'], now: string | undefined = NOW_ISO) =>
      checkLabelOffset(s(sourcesDoc({ sources: [de1(), lu1({ label_offset })] })).data, now);
    expect(at(offset())).toEqual({
      check: 'label offset LU-1',
      ok: true,
      detail: 'day 2026-10-01: decided over 34 instants (share 0.978); 15 min since 2026-10-01',
    });
    // Review CR-4: freshness is the latest day tried. A run of quiet days that decided nothing still passes while
    // the detector runs, and the offset in force is the one of the latest day that decided it.
    const quiet = offset({ day: '2026-10-02', decided: false, n_aligned: 5, share: null, decided_day: '2026-09-25' });
    expect(at(quiet)).toEqual({
      check: 'label offset LU-1',
      ok: true,
      detail: 'day 2026-10-02: undecided (5 instants); 15 min since 2026-09-25',
    });
    expect(at({ ...quiet, minutes: null, decided_day: null })).toMatchObject({
      ok: true,
      detail: 'day 2026-10-02: undecided (5 instants); no day decided yet',
    });
    // A detector that stopped running fails, decided or not.
    expect(at({ ...quiet, day: '2026-09-29' }).ok).toBe(false);
    // Any value is reported, not judged; a zero or a negative offset is as good as 15.
    expect(at(offset({ minutes: 0 })).ok).toBe(true);
    expect(at(offset({ minutes: -15 }))).toMatchObject({ ok: true, detail: expect.stringContaining('-15 min') });
    // 2026-10-02T12:00Z less 2 days is 2026-09-30: that day passes, the one before fails.
    expect(at(offset({ day: '2026-09-30' })).ok).toBe(true);
    expect(at(offset({ day: '2026-09-29' }))).toMatchObject({
      ok: false,
      detail:
        'day 2026-09-29: decided over 34 instants (share 0.978); 15 min since 2026-10-01, older than 2026-09-30 (2 days before now)',
    });
    expect(at(offset({ day: '2026-10-03' }))).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/, after 2026-10-02$/),
    });
    expect(at(offset({ day: '2026-10-02' })).ok).toBe(true);
    expect(at(null)).toEqual({ check: 'label offset LU-1', ok: false, detail: 'no label offset measured yet' });
    const doc = s(sourcesDoc({ sources: [de1(), lu1({ label_offset: offset() })] })).data;
    expect(checkLabelOffset(doc, undefined)).toMatchObject({ ok: false, detail: 'no valid meta document' });
    expect(at(offset(), 'yesterday')).toMatchObject({ ok: false, detail: 'no valid meta document' });
    expect(checkLabelOffset(s().data, NOW_ISO)).toMatchObject({ ok: false, detail: /not listed/ });
    expect(checkLabelOffset(undefined, NOW_ISO)).toMatchObject({
      ok: false,
      detail: /no valid health\/sources document/,
    });
    expect(at(offset()).detail).toMatch(/^[0-9A-Za-z .,%:();-]+$/);
    expect(at(quiet).detail).toMatch(/^[0-9A-Za-z .,%:();-]+$/);
  });

  it('label_offset must be a day, a decision, minutes and a share: anything else is no document', () => {
    for (const bad of [
      { ...offset(), extra: 1 },
      offset({ day: '2026-10-01T00:00:00Z' }),
      offset({ decided_day: '2026-10-01T00:00:00Z' }),
      offset({ share: 2 }),
      offset({ n_aligned: -1 }),
      offset({ decided: 'yes' as never }),
    ])
      expect(s(sourcesDoc({ sources: [lu1({ label_offset: bad })] })).data).toBeUndefined();
    expect(s(sourcesDoc({ sources: [lu1({ label_offset: undefined as never })] })).data).toBeUndefined();
  });

  it('fresh DE-7 is 90 minutes and fresh LU-1 is 75, every other source keeps 45', () => {
    expect([
      FRESH_MAX_AGE_S,
      freshLimit('DE-7'),
      freshLimit('LU-1'),
      freshLimit('NL-1'),
      freshLimit('constructor'),
    ]).toEqual([2700, 5400, 4500, 2700, 2700]);
    expect([...FRESH_MAX_AGE_BY_SOURCE.keys()]).toEqual(['DE-7', 'LU-1']);
    const now = new Date(NOW_MS).toISOString();
    const at = (ages: Record<number, number>) => snapshotDoc(NOW_MS, ages);
    expect(checkFresh('DE-7', at({ 6: 5400 }), stationsDoc(), now)).toEqual({
      check: 'fresh DE-7',
      ok: true,
      detail: '1 of 1 DE-7 series have a value, the newest is 5400 s old',
    });
    expect(checkFresh('DE-7', at({ 6: 5401 }), stationsDoc(), now)).toMatchObject({
      ok: false,
      detail: '1 of 1 DE-7 series have a value, the newest is 5401 s old, over 5400 s',
    });
    expect(checkFresh('LU-1', at({ 7: 4500 }), stationsDoc(), now).ok).toBe(true);
    expect(checkFresh('LU-1', at({ 7: 4501 }), stationsDoc(), now)).toMatchObject({
      ok: false,
      detail: '1 of 1 LU-1 series have a value, the newest is 4501 s old, over 4500 s',
    });
    // A DE-7 value of 60 minutes is stale for DE-1 and fresh for DE-7: the limits are per source.
    expect(checkFresh('DE-7', at({ 6: 3600, 3: 60 }), stationsDoc(), now).ok).toBe(true);
    expect(checkFresh('DE-1', at({ 3: 3600 }), stationsDoc(), now).ok).toBe(false);
  });

  it('the --dry-run list states the new rules', () => {
    const one = (name: string) => {
      const found = CHECKS.filter((c) => c.startsWith(`${name}:`));
      expect(found, name).toHaveLength(1);
      return found[0] ?? '';
    };
    expect(one('interval DE-7')).toMatch(/>= 895 s.*3600.*900/);
    expect(one('bytes DE-7')).toContain('90 MB');
    expect(one('fresh DE-7')).toContain('5400 s');
    expect(one('fresh LU-1')).toContain('4500 s');
    expect(one('fresh NL-1')).toContain('2700 s');
    expect(one('label offset LU-1')).toContain('2 days');
    for (const name of ['health DE-7', 'tier-1 LU-1', 'coverage DE-7', 'coverage LU-1']) one(name);
  });
});

// The Eijsden-grens twin (P2b soak): TAW - NAP = 233 +- 1 cm, checked hourly by the loader.

describe('twin eijsden-grens-taw-nap', () => {
  const ID = 'eijsden-grens-taw-nap';
  const HOUR = 3_600_000;
  type Twin = HealthSources['twins'][number];
  const twin = (over: Partial<Twin> = {}): Twin => ({
    id: ID,
    window_end: ago(30 * 60_000),
    n_aligned: 44,
    median_delta: 233,
    max_delta: 233,
    lag_min: null,
    ok: true,
    checks_7d: 168,
    failed_7d: 0,
    ...over,
  });
  const check = (over: Partial<Twin> = {}) => checkTwin(s(sourcesDoc({ twins: [twin(over)] })), NOW);

  it('passes: listed, fresh, aligned, ok, nothing failed in 7 days and enough checks', () => {
    expect(check()).toEqual({
      check: `twin ${ID}`,
      ok: true,
      detail: '44 aligned timestamps in the latest check, 168 checks in 7 days, none failed',
    });
  });

  it('fails when the twin is not listed, whatever else is', () => {
    expect(checkTwin(s(), NOW)).toEqual({
      check: `twin ${ID}`,
      ok: false,
      detail: 'not listed in /api/v1/health/sources',
    });
    expect(checkTwin(s(sourcesDoc({ twins: [twin({ id: 'other-pair' })] })), NOW).detail).toBe(
      'not listed in /api/v1/health/sources',
    );
    // Another id is asked for by name.
    expect(checkTwin(s(sourcesDoc({ twins: [twin({ id: 'other-pair' })] })), NOW, 'other-pair')).toMatchObject({
      check: 'twin other-pair',
      ok: true,
    });
  });

  it('the latest check must be at most 2 hours old: exactly 2 h passes, one second more fails', () => {
    expect(check({ window_end: ago(2 * HOUR) }).ok).toBe(true);
    expect(check({ window_end: ago(2 * HOUR + 1000) })).toMatchObject({
      ok: false,
      detail: 'latest check is 121 min old (limit 120 min)',
    });
    expect(check({ window_end: ago(5 * HOUR) }).detail).toBe('latest check is 300 min old (limit 120 min)');
  });

  it('fails without aligned timestamps and when the latest check is outside the tolerance', () => {
    expect(check({ n_aligned: 0 })).toMatchObject({ ok: false, detail: 'no aligned timestamps' });
    expect(check({ n_aligned: 1 }).ok).toBe(true);
    expect(check({ ok: false })).toMatchObject({ ok: false, detail: 'the latest check is outside the tolerance' });
  });

  it('fails on a lag: only a lag of 0 (or none measured) passes', () => {
    expect(check({ lag_min: 0 }).ok).toBe(true);
    expect(check({ lag_min: 15 })).toMatchObject({ ok: false, detail: 'the latest check finds a lag of 15 min' });
    expect(check({ lag_min: -5, ok: false }).detail).toBe(
      'the latest check is outside the tolerance; the latest check finds a lag of -5 min',
    );
  });

  it('fails on any failed check of the 7 days', () => {
    expect(check({ failed_7d: 1 })).toMatchObject({ ok: false, detail: '1 of 168 checks failed in 7 days' });
    expect(check({ failed_7d: 12 }).detail).toBe('12 of 168 checks failed in 7 days');
    expect(check({ ok: false, failed_7d: 1 }).detail).toBe(
      'the latest check is outside the tolerance; 1 of 168 checks failed in 7 days',
    );
  });

  it('needs 160 of the 168 hourly checks: 160 passes, 159 fails', () => {
    expect(check({ checks_7d: 160 }).ok).toBe(true);
    expect(check({ checks_7d: 159 })).toMatchObject({
      ok: false,
      detail: 'only 159 checks in 7 days: the soak needs 160',
    });
    expect(check({ checks_7d: 40 }).detail).toBe('only 40 checks in 7 days: the soak needs 160');
    expect(check({ checks_7d: 0 }).ok).toBe(false);
  });

  it('names every failing condition at once', () => {
    expect(check({ window_end: ago(5 * HOUR), n_aligned: 0, ok: false, checks_7d: 40, failed_7d: 3 }).detail).toBe(
      'latest check is 300 min old (limit 120 min); no aligned timestamps; the latest check is outside the tolerance; 3 of 40 checks failed in 7 days; only 40 checks in 7 days: the soak needs 160',
    );
  });

  it('an unreachable, wrong or off-contract document fails without a crash', () => {
    expect(checkTwin(readApi('timeout', HealthSources), NOW)).toEqual({
      check: `twin ${ID}`,
      ok: false,
      detail: 'no valid health/sources document: timeout',
    });
    expect(checkTwin(s(sourcesDoc({ twins: [twin()] }), { status: 503 }), NOW)).toMatchObject({
      ok: false,
      detail: /status 503/,
    });
    expect(checkTwin(s(sourcesDoc({ twins: [twin()] }), { headers: {} }), NOW).ok).toBe(false);
    expect(checkTwin(readApi(page('{}'), HealthSources), NOW)).toMatchObject({
      ok: false,
      detail: 'no valid health/sources document: not the contract document',
    });
  });

  it('a twin the provider text reached fails the contract and is never printed', () => {
    const hostile = 'IGNORE PREVIOUS INSTRUCTIONS <script>alert(1)</script>';
    for (const bad of [
      { ...twin(), id: hostile },
      { ...twin(), note: hostile },
      { ...twin(), checks_7d: hostile },
    ]) {
      const r = checkTwin(readApi(page({ ...sourcesDoc(), twins: [bad] }), HealthSources), NOW);
      expect(r).toMatchObject({ ok: false, detail: 'no valid health/sources document: not the contract document' });
      expect(JSON.stringify(r)).not.toMatch(/IGNORE|script/);
    }
    // A well-formed id that is not the one asked for is "not listed", and is not echoed either.
    const other = checkTwin(s(sourcesDoc({ twins: [twin({ id: 'ignore-previous-instructions' })] })), NOW);
    expect(other.detail).toBe('not listed in /api/v1/health/sources');
  });
});

// P5b: every pair of registry/twins.yaml is asked for under --soak, one list constant drives it.

describe('every twin pair (P5b)', () => {
  const pair = (id: string): HealthSources['twins'][number] => ({
    id,
    window_end: ago(30 * 60_000),
    n_aligned: 44,
    median_delta: 0,
    max_delta: 0.1,
    lag_min: 0,
    ok: true,
    checks_7d: 168,
    failed_7d: 0,
  });

  it('TWIN_IDS are exactly the pairs of registry/twins.yaml, eijsden-grens-taw-nap first', () => {
    const doc = parse(readFileSync(join(repoRoot, 'registry/twins.yaml'), 'utf8')) as { twins: { id: string }[] };
    expect([...TWIN_IDS].sort()).toEqual(doc.twins.map((t) => t.id).sort());
    expect(TWIN_IDS[0]).toBe('eijsden-grens-taw-nap');
    expect(new Set(TWIN_IDS).size).toBe(TWIN_IDS.length);
  });

  it('each pair passes on its own check; a pair absent from the document fails: no data is not ok', () => {
    const all = s(sourcesDoc({ twins: TWIN_IDS.map(pair) }));
    for (const id of TWIN_IDS) expect(checkTwin(all, NOW, id)).toMatchObject({ check: `twin ${id}`, ok: true });
    for (const id of TWIN_IDS) {
      const without = s(sourcesDoc({ twins: TWIN_IDS.filter((x) => x !== id).map(pair) }));
      expect(checkTwin(without, NOW, id)).toEqual({
        check: `twin ${id}`,
        ok: false,
        detail: 'not listed in /api/v1/health/sources',
      });
    }
  });

  it('one failing pair fails its own check only', () => {
    const doc = s(
      sourcesDoc({
        twins: TWIN_IDS.map((id) => (id === 'perl-lu1-de1-h' ? { ...pair(id), lag_min: 15, ok: false } : pair(id))),
      }),
    );
    expect(checkTwin(doc, NOW, 'perl-lu1-de1-h').ok).toBe(false);
    expect(checkTwin(doc, NOW, 'basel-ch1-de1-h').ok).toBe(true);
  });
});

describe('owner isolation in the health API', () => {
  const terms = leakTerms(registry);

  it('knows the owner sources, specs and hosts, both renderings of both canaries', () => {
    expect(terms).toEqual(
      expect.arrayContaining([...ownerTerms(registry), '777777.777', '777777.75', '123456.789', '123456.79']),
    );
    // The VPS tripwire list (deploy/owner-terms.json) stays the owner terms only.
    expect(ownerTerms(registry)).not.toContain('123456.79');
  });

  it('finds nothing in real health documents', () => {
    const body = { '/api/v1/health': JSON.stringify(health()), '/api/v1/health/sources': JSON.stringify(sourcesDoc()) };
    expect(checkOwnerLeak(body, terms)).toMatchObject({ check: 'owner leak', ok: true });
  });

  it.each([
    ['an owner source id', { sources: [de1({ id: 'BE-3' })] }, /BE-3/],
    [
      'the owner canary as typed',
      {
        twins: [
          {
            id: 'x',
            window_end: ago(1),
            n_aligned: 1,
            median_delta: 777777.777,
            max_delta: 1,
            lag_min: null,
            ok: true,
            checks_7d: 1,
            failed_7d: 0,
          },
        ],
      },
      /777777\.777/,
    ],
    [
      'the owner canary as real prints it',
      {
        twins: [
          {
            id: 'x',
            window_end: ago(1),
            n_aligned: 1,
            median_delta: 777777.75,
            max_delta: 1,
            lag_min: null,
            ok: true,
            checks_7d: 1,
            failed_7d: 0,
          },
        ],
      },
      /777777\.75/,
    ],
    [
      'the withheld canary',
      {
        twins: [
          {
            id: 'x',
            window_end: ago(1),
            n_aligned: 1,
            median_delta: 123456.789,
            max_delta: 1,
            lag_min: null,
            ok: true,
            checks_7d: 1,
            failed_7d: 0,
          },
        ],
      },
      /123456\.789/,
    ],
    [
      'the withheld canary as real prints it',
      {
        twins: [
          {
            id: 'x',
            window_end: ago(1),
            n_aligned: 1,
            median_delta: 123456.79,
            max_delta: 1,
            lag_min: null,
            ok: true,
            checks_7d: 1,
            failed_7d: 0,
          },
        ],
      },
      /123456\.79/,
    ],
    [
      'an owner host',
      {
        quarantined_batches: [
          { id: '1', source: 'DE-1', spec: 'x', fetched_at: ago(1), error: 'hydrometrie.wallonie.be' },
        ],
      },
      /hydrometrie\.wallonie\.be/,
    ],
    [
      'an owner spec',
      { quarantined_batches: [{ id: '1', source: 'DE-1', spec: 'lu-3-percentile', fetched_at: ago(1), error: null }] },
      /lu-3-percentile/,
    ],
  ])('fails on %s', (_, over, detail) => {
    const result = checkOwnerLeak(
      { '/api/v1/health/sources': JSON.stringify(sourcesDoc(over as Partial<HealthSources>)) },
      terms,
    );
    expect(result).toMatchObject({ ok: false, detail: expect.stringMatching(detail) });
  });

  it('fails on a private_basis key at any depth, whatever its value', () => {
    expect(ownerKeys({ a: [{ b: { private_basis: 1 } }], Private_Basis: 2 })).toEqual([
      'private_basis',
      'Private_Basis',
    ]);
    expect(ownerKeys({ clause: 'x', url: 'y' })).toEqual([]);
    const withKey = JSON.stringify({ ...health(), owner_sources: { healthy: 1, total: 2, private_basis: null } });
    expect(checkOwnerLeak({ '/api/v1/health': withKey }, terms)).toMatchObject({
      ok: false,
      detail: /key private_basis/,
    });
    expect(checkOwnerLeak({ '/api/v1/health': '' }, terms).ok).toBe(true);
  });

  it('a value that only contains a canary as a prefix is not a leak', () => {
    expect(checkOwnerLeak({ x: '{"v":777777.7771}' }, terms).ok).toBe(true);
    expect(checkOwnerLeak({ x: '{"v":7777777.75}' }, terms).ok).toBe(true);
  });
});

// The basemap tiles (P3, ADR-0016): the pure checks on synthetic responses.

const SHA = 'a'.repeat(64);
const tileEntry = (build: string, bytes: number) => ({
  build,
  version: '4.15.2',
  created_at: '2026-10-01T09:00:00Z',
  basemap: { file: `basemap-${build}.pmtiles`, sha256: SHA, bytes },
  planet: { file: `planet-z6-${build}.pmtiles`, sha256: SHA, bytes: bytes / 2 },
});
const manifestDoc = (previous = false): TilesManifest => ({
  schema_version: 1,
  current: tileEntry('20261001', 6000),
  previous: previous ? tileEntry('20260924', 5000) : null,
});
const manifestPage = (doc: unknown = manifestDoc(), over: Partial<Page> = {}): Page => ({
  status: 200,
  headers: { 'content-type': 'application/json', 'cache-control': MANIFEST_CACHE },
  body: typeof doc === 'string' ? doc : JSON.stringify(doc),
  ...over,
});
const tilePage = (file: TileFile, over: Partial<Page> = {}): Page => ({
  status: 206,
  headers: { 'content-range': `bytes 0-15/${file.bytes}`, 'cache-control': TILE_CACHE, 'content-length': '16' },
  body: `${PMTILES_MAGIC}${'\u0000'.repeat(8)}`,
  ...over,
});
const currentBasemap = manifestDoc().current.basemap;

describe('verify-prod: the tiles manifest', () => {
  it('passes: 200, exactly max-age=60 and a manifest parseTilesManifest accepts', () => {
    const r = checkTilesManifestPage(readTilesManifest(manifestPage()));
    expect(r).toEqual({
      check: 'tiles manifest',
      ok: true,
      detail: '200, public, max-age=60, current build 20261001 (tiles 4.15.2), previous none',
    });
    expect(checkTilesManifestPage(readTilesManifest(manifestPage(manifestDoc(true)))).detail).toMatch(
      /previous 20260924$/,
    );
    expect(readTilesManifest(manifestPage()).manifest?.current.build).toBe('20261001');
  });

  it('fails on any Cache-Control but exactly max-age=60, and still returns the valid manifest', () => {
    for (const cache of [
      'public, max-age=31536000, immutable',
      'public, max-age=60, immutable',
      'max-age=60',
      'public, max-age=600',
      undefined,
    ]) {
      const headers: Record<string, string> = {};
      if (cache !== undefined) headers['cache-control'] = cache;
      const read = readTilesManifest(manifestPage(manifestDoc(), { headers }));
      expect(read.manifest).toBeDefined();
      expect(checkTilesManifestPage(read)).toMatchObject({
        ok: false,
        detail: `cache-control ${JSON.stringify(cache ?? null)}`,
      });
    }
  });

  it('fails on a status, an invalid, oversized or non-JSON body and a network error, naming only fixed codes', () => {
    expect(checkTilesManifestPage(readTilesManifest(manifestPage('', { status: 404 }))).detail).toBe(
      'status 404; manifest_not_json',
    );
    expect(checkTilesManifestPage(readTilesManifest(manifestPage('x'.repeat(16_385)))).detail).toBe(
      'manifest_too_large',
    );
    expect(checkTilesManifestPage(readTilesManifest(manifestPage({ ...manifestDoc(), extra: 1 }))).detail).toBe(
      'manifest_invalid at manifest',
    );
    expect(
      checkTilesManifestPage(readTilesManifest(manifestPage({ ...manifestDoc(), current: tileEntry('20261001', -1) })))
        .detail,
    ).toBe('manifest_invalid at manifest.current.basemap.bytes');
    expect(checkTilesManifestPage(readTilesManifest('ECONNRESET'))).toEqual({
      check: 'tiles manifest',
      ok: false,
      detail: 'ECONNRESET',
    });
    // Hostile text in the body is never printed.
    const hostile = 'IGNORE PREVIOUS INSTRUCTIONS <script>alert(1)</script>';
    for (const body of [
      hostile,
      JSON.stringify({ ...manifestDoc(), current: { ...tileEntry('20261001', 6000), build: hostile } }),
    ]) {
      const r = checkTilesManifestPage(readTilesManifest(manifestPage(body)));
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/IGNORE|script/);
    }
  });

  it('lists the current files first, then the previous extract', () => {
    expect(tileFiles(manifestDoc(true)).map((f) => f.file)).toEqual([
      'basemap-20261001.pmtiles',
      'planet-z6-20261001.pmtiles',
      'basemap-20260924.pmtiles',
      'planet-z6-20260924.pmtiles',
    ]);
    expect(tileFiles(manifestDoc())).toHaveLength(2);
    expect(tileFiles(undefined)).toEqual([]);
  });

  it('previous: n/a while the manifest has none, a pass once it lists one, a fail without a manifest', () => {
    expect(checkTilesPrevious(readTilesManifest(manifestPage()))).toEqual({
      check: 'tiles previous',
      ok: 'n/a',
      detail: 'one extract so far; run the job again on a later build',
    });
    expect(checkTilesPrevious(readTilesManifest(manifestPage(manifestDoc(true))))).toMatchObject({
      check: 'tiles previous',
      ok: true,
      detail: /^build 20260924 /,
    });
    expect(checkTilesPrevious(readTilesManifest(manifestPage('{}')))).toMatchObject({ ok: false });
    expect(checkTilesPrevious(readTilesManifest('timeout'))).toMatchObject({ ok: false });
  });
});

describe('verify-prod: a tile file read with a Range', () => {
  it('asks for 16 bytes and offers the encodings a browser does', () => {
    expect(TILE_HEADERS).toEqual({ range: 'bytes=0-15', 'accept-encoding': 'gzip, zstd' });
  });

  it('passes: 206, the manifest byte count as total, immutable, no Content-Encoding, the PMTiles v3 magic', () => {
    expect(checkTileFile(currentBasemap, tilePage(currentBasemap))).toEqual({
      check: 'tiles basemap-20261001.pmtiles',
      ok: true,
      detail: '206, bytes 0-15/6000, immutable, no Content-Encoding, PMTiles v3',
    });
  });

  const fails = (over: Partial<Page>, detail: string | RegExp) => {
    const r = checkTileFile(currentBasemap, tilePage(currentBasemap, over));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(detail);
  };
  const headers = (over: Record<string, string | undefined>) => ({
    ...tilePage(currentBasemap).headers,
    ...over,
  });

  it('fails when the server ignored the Range (200)', () => {
    fails(
      { status: 200, headers: headers({ 'content-range': undefined }) },
      /^status 200, want 206; content-range null/,
    );
  });

  it('fails on a Content-Range that is not bytes 0-15 of the manifest total', () => {
    fails(
      { headers: headers({ 'content-range': 'bytes 0-15/5999' }) },
      /content-range "bytes 0-15\/5999", want bytes 0-15\/6000/,
    );
    fails({ headers: headers({ 'content-range': 'bytes 0-7/6000' }) }, /content-range "bytes 0-7\/6000"/);
    fails({ headers: headers({ 'content-range': undefined }) }, /content-range null/);
  });

  it('fails on any Cache-Control but exactly immutable for a year', () => {
    for (const cache of ['public, max-age=60', 'max-age=31536000, immutable', 'public, max-age=31536000', undefined])
      fails({ headers: headers({ 'cache-control': cache }) }, `cache-control ${JSON.stringify(cache ?? null)}`);
  });

  it('fails on a Content-Encoding (a compressed 206 breaks the byte offsets)', () => {
    fails({ headers: headers({ 'content-encoding': 'gzip' }) }, 'content-encoding "gzip"');
    fails({ headers: headers({ 'content-encoding': 'zstd' }) }, 'content-encoding "zstd"');
  });

  it('fails on a body that is not a PMTiles v3 file', () => {
    fails({ body: '\u001f\u008b\b\u0000' }, 'not a PMTiles v3 file');
    fails({ body: `PMTiles\u0002${'\u0000'.repeat(8)}` }, 'not a PMTiles v3 file');
    fails({ body: '' }, 'not a PMTiles v3 file');
    fails({ body: '<html>' }, 'not a PMTiles v3 file');
  });

  it('names every difference at once, and a network error', () => {
    const r = checkTileFile(
      currentBasemap,
      tilePage(currentBasemap, { status: 200, headers: { 'content-encoding': 'gzip' }, body: 'x' }),
    );
    expect(r.detail).toBe(
      'status 200, want 206; content-range null, want bytes 0-15/6000; cache-control null; content-encoding "gzip"; not a PMTiles v3 file',
    );
    expect(checkTileFile(currentBasemap, 'body too large')).toEqual({
      check: 'tiles basemap-20261001.pmtiles',
      ok: false,
      detail: 'body too large',
    });
  });
});

describe('verify-prod: the 404s and the pinned map assets', () => {
  const notFound = (over: Partial<Page> = {}): Page => ({ status: 404, headers: {}, body: '', ...over });
  const all = (over: Record<string, Page | string> = {}): Record<string, Page | string> => ({
    ...Object.fromEntries(TILES_404_PATHS.map((p) => [p, notFound()])),
    ...over,
  });

  it('tiles 404: the directory, .staging and a never-promoted dated name', () => {
    expect([...TILES_404_PATHS]).toEqual(['/tiles/', '/tiles/.staging/', '/tiles/basemap-19700101.pmtiles']);
    expect(checkTiles404(all())).toMatchObject({ check: 'tiles 404', ok: true });
  });

  it('tiles 404 fails on any other status, an immutable 404 and a network error', () => {
    expect(checkTiles404(all({ '/tiles/.staging/': notFound({ status: 200 }) }))).toMatchObject({
      ok: false,
      detail: '/tiles/.staging/: status 200, want 404',
    });
    expect(checkTiles404(all({ '/tiles/': notFound({ status: 403 }) })).ok).toBe(false);
    expect(
      checkTiles404(
        all({
          '/tiles/basemap-19700101.pmtiles': notFound({
            headers: { 'cache-control': 'public, max-age=31536000, immutable' },
          }),
        }),
      ),
    ).toMatchObject({ ok: false, detail: '/tiles/basemap-19700101.pmtiles: a 404 marked immutable' });
    expect(checkTiles404(all({ '/tiles/': notFound({ headers: { 'cache-control': 'no-store' } }) })).ok).toBe(true);
    expect(checkTiles404(all({ '/tiles/': 'ECONNRESET' })).detail).toBe('/tiles/: ECONNRESET');
    expect(checkTiles404({}).ok).toBe(false);
  });

  const refused = (over: Partial<Page> = {}): Page => ({ status: 416, headers: {}, body: '', ...over });
  const asked = (over: Record<string, Page | string> = {}): Record<string, Page | string> => ({
    ...Object.fromEntries(TILE_416_REQUESTS.map(([label]) => [label, refused()])),
    ...over,
  });

  it('tiles 416: the current basemap file without a Range and with two ranges (SR-1)', () => {
    expect(TILE_416_REQUESTS).toEqual([
      ['no Range', {}],
      ['two ranges', { range: 'bytes=0-0,2-2' }],
    ]);
    expect(checkTiles416(currentBasemap, asked())).toEqual({
      check: 'tiles 416',
      ok: true,
      detail: 'basemap-20261001.pmtiles: no Range and two ranges are 416, not immutable',
    });
  });

  it('tiles 416 fails on a served file (200 or a multipart 206), an immutable 416, a network error and no manifest', () => {
    expect(checkTiles416(currentBasemap, asked({ 'no Range': refused({ status: 200 }) }))).toMatchObject({
      ok: false,
      detail: 'no Range: status 200, want 416',
    });
    expect(checkTiles416(currentBasemap, asked({ 'two ranges': refused({ status: 206 }) })).detail).toBe(
      'two ranges: status 206, want 416',
    );
    expect(
      checkTiles416(currentBasemap, asked({ 'two ranges': refused({ headers: { 'cache-control': TILE_CACHE } }) }))
        .detail,
    ).toBe('two ranges: marked immutable');
    // A range-less GET that is answered with the file is cut off by the 8 MiB cap of the request: a FAIL.
    expect(checkTiles416(currentBasemap, asked({ 'no Range': 'body too large' })).detail).toBe(
      'no Range: body too large',
    );
    expect(checkTiles416(currentBasemap, {}).detail).toBe('no Range: not asked; two ranges: not asked');
    expect(checkTiles416(undefined, asked())).toEqual({ check: 'tiles 416', ok: false, detail: 'no valid manifest' });
  });

  const asset = (over: Partial<Page> = {}): Page => ({
    status: 200,
    headers: { 'cache-control': TILE_CACHE },
    body: 'glyph bytes',
    ...over,
  });

  it('map assets: 200, immutable, not empty', () => {
    expect(checkMapAsset(asset())).toEqual({
      check: 'map assets',
      ok: true,
      detail: `${MAP_ASSET_PATH}: 200, immutable`,
    });
    expect(checkMapAsset(asset({ status: 404 })).detail).toBe('status 404, want 200');
    expect(checkMapAsset(asset({ headers: {} })).detail).toBe('cache-control null');
    expect(checkMapAsset(asset({ headers: { 'cache-control': 'public, max-age=60' } })).ok).toBe(false);
    expect(checkMapAsset(asset({ body: '' })).detail).toBe('empty body');
    expect(checkMapAsset('timeout')).toEqual({ check: 'map assets', ok: false, detail: 'timeout' });
  });

  it('the asset path is the directory registry/basemap.yaml pins, and a font it lists', () => {
    const { basemap } = validateBasemap(parse(readFileSync(join(repoRoot, 'registry/basemap.yaml'), 'utf8')));
    expect(basemap).toBeDefined();
    if (basemap === undefined) return;
    expect(MAP_ASSET_PATH.startsWith(basemapAssetsPath(basemap))).toBe(true);
    expect(MAP_ASSET_PATH).toContain(`/fonts/${encodeURIComponent('Noto Sans Regular')}/`);
    expect(basemap.assets.fonts).toContain('Noto Sans Regular');
  });

  it('the --dry-run list names every new check, and the checks do not echo bodies', () => {
    for (const name of ['tiles manifest', 'tiles <file>', 'tiles previous', 'tiles 404', 'tiles 416', 'map assets'])
      expect(
        CHECKS.filter((c) => c.startsWith(`${name}:`)),
        name,
      ).toHaveLength(1);
    expect(CHECKS.find((c) => c.startsWith('tiles <file>:'))).toContain('Range: bytes=0-15');
    expect(CHECKS.find((c) => c.startsWith('tiles 416:'))).toContain('Range: bytes=0-0,2-2');
  });
});

// The P4b data API (issue #19) through Caddy: the pure checks on synthetic answers.

const SERVER_NOW = '2026-10-02T12:03:41.000Z'; // its 10-minute floor is 12:00
const BUILD = '0123456789abcdef0123456789abcdef01234567';
const metaDoc = (over: Partial<Meta> = {}): Meta => ({
  now: SERVER_NOW,
  dataEpoch: '2026-10-02T00:00:00.000Z',
  displayStart: '2026-08-24T00:00:00.000Z',
  build: BUILD,
  sources: [
    { id: 'NL-1', attribution: [] },
    {
      id: 'DE-1',
      attribution: [
        { lang: 'de', text: 'Datenquelle: WSV', url: 'https://example.org/de', required: true, needsDate: false },
      ],
    },
    { id: 'FR-1', attribution: [] },
    { id: 'CH-1', attribution: [] },
    { id: 'DE-7', attribution: [] },
    { id: 'LU-1', attribution: [] },
  ],
  forecastHorizons: [
    { source: 'CH-4', hours: 48 },
    { source: 'FR-4', hours: 48 },
    { source: 'NL-1', hours: 48 },
  ],
  ...over,
});
const seriesDoc = (id: number, source: string, quantity: 'H' | 'Q') => ({
  id,
  source,
  quantity,
  valueKind: quantity === 'H' ? 'stage' : null,
  unit: quantity === 'H' ? 'cm' : 'm³/s',
  datum: null,
  nativeUnit: quantity === 'H' ? 'cm' : 'm³/s',
  expectedStepSeconds: 600,
  stalenessLimitSeconds: 3600,
  dataSince: '2026-10-01T00:00:00.000Z',
});
const stationDoc = (id: string, country: string, series: unknown[]) => ({
  id,
  name: 'Lobith',
  waterName: 'Rijn',
  country,
  lon: 6.1,
  lat: 51.8,
  tier: 1,
  flags: { tidal: false, impounded: null },
  series,
});
// Series 1 and 2 are NL-1, series 3 is DE-1, series 4 is FR-1, series 5 is CH-1, series 6 is DE-7, series 7 is LU-1.
const stationsDoc = (): Stations =>
  Stations.parse({
    stations: [
      stationDoc('nl.rws.lobith.bovenrijn.tolkamer', 'NL', [seriesDoc(1, 'NL-1', 'H'), seriesDoc(2, 'NL-1', 'Q')]),
      stationDoc('de.wsv.kaub', 'DE', [seriesDoc(3, 'DE-1', 'H')]),
      stationDoc('fr.sandre.A701061001', 'FR', [seriesDoc(4, 'FR-1', 'Q')]),
      stationDoc('ch.bafu.2289', 'CH', [seriesDoc(5, 'CH-1', 'H')]),
      stationDoc('de.lanuk.2768898001', 'DE', [seriesDoc(6, 'DE-7', 'H')]),
      stationDoc('lu.age.Perl', 'LU', [seriesDoc(7, 'LU-1', 'H')]),
    ],
  });
const snapshotDoc = (ms: number, ages: Record<number, number> = { 1: 600, 3: 1200 }): Snapshot =>
  Snapshot.parse({
    t: new Date(ms).toISOString(),
    values: Object.entries(ages).map(([series, ageSeconds]) => ({
      series: Number(series),
      ts: new Date(ms - ageSeconds * 1000).toISOString(),
      value: 1234,
      qc: 0,
      ageSeconds,
      state: 'no_ref',
      basis: null,
      section: false,
    })),
  });
const apiPage = (doc: unknown, cache: string, over: Partial<Page> = {}): Page =>
  page(doc, { headers: { 'content-type': 'application/json', 'cache-control': cache }, ...over });
const NOW_MS = Date.parse('2026-10-02T12:00:00Z');
const [NOW_ASK, H6_ASK, D3_ASK] = SNAPSHOT_ASKS;
const snapRead = (ask: SnapshotAsk, ms: number, over: Partial<Page> = {}, doc: unknown = snapshotDoc(ms)) =>
  readSnapshot(ask, ms, apiPage(doc, ask.cache, over));

describe('api meta and api build', () => {
  const read = (doc: unknown = metaDoc(), over: Partial<Page> = {}) =>
    readApi(apiPage(doc, META_CACHE, over), Meta, META_CACHE);

  it('meta passes: 200, exactly max-age=60, the Meta contract, NL-1 and DE-1 listed', () => {
    expect(checkMeta(read())).toEqual({
      check: 'api meta',
      ok: true,
      detail: '200, public, max-age=60, the Meta contract, sources NL-1, DE-1, FR-1, CH-1, DE-7, LU-1',
    });
    expect(API_SOURCES).toEqual(['NL-1', 'DE-1', 'FR-1', 'CH-1', 'DE-7', 'LU-1']);
  });

  it('meta fails on a wrong Cache-Control, a wrong status, a body off the contract, a missing source and a network error', () => {
    expect(
      checkMeta(
        read(metaDoc(), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' } }),
      ),
    ).toMatchObject({
      ok: false,
      detail: 'cache-control "public, max-age=30"',
    });
    expect(checkMeta(read(metaDoc(), { headers: { 'content-type': 'application/json' } })).detail).toBe(
      'cache-control ""',
    );
    expect(checkMeta(read(metaDoc(), { status: 503 }))).toMatchObject({ ok: false, detail: 'status 503' });
    expect(checkMeta(read({ ...metaDoc(), extra: 1 }))).toMatchObject({
      ok: false,
      detail: 'not the contract document',
    });
    expect(checkMeta(read('<html>')).ok).toBe(false);
    expect(checkMeta(read(metaDoc({ sources: [{ id: 'NL-1', attribution: [] }] })))).toMatchObject({
      ok: false,
      detail:
        'DE-1 is not listed in sources; FR-1 is not listed in sources; CH-1 is not listed in sources; DE-7 is not listed in sources; LU-1 is not listed in sources',
    });
    // FR-1 and CH-1 count since P5a, DE-7 and LU-1 since P5b: each alone makes the check fail.
    for (const id of ['FR-1', 'CH-1', 'DE-7', 'LU-1'])
      expect(checkMeta(read(metaDoc({ sources: metaDoc().sources.filter((x) => x.id !== id) })))).toMatchObject({
        ok: false,
        detail: `${id} is not listed in sources`,
      });
    expect(checkMeta(read(metaDoc({ sources: [] }))).detail).toBe(
      'NL-1 is not listed in sources; DE-1 is not listed in sources; FR-1 is not listed in sources; CH-1 is not listed in sources; DE-7 is not listed in sources; LU-1 is not listed in sources',
    );
    expect(checkMeta(readApi('ECONNRESET', Meta, META_CACHE))).toEqual({
      check: 'api meta',
      ok: false,
      detail: 'ECONNRESET',
    });
  });

  it('build passes for a 40-hex commit and fails for dev (KG-109), whatever else is off in the answer', () => {
    expect(checkBuild(metaDoc())).toEqual({ check: 'api build', ok: true, detail: `build ${BUILD}` });
    expect(checkBuild(metaDoc({ build: 'dev' }))).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/"dev".*RWS_BUILD.*KG-109/),
    });
    // The contract admits only 40 lowercase hex or dev, so an uppercase or short build is no document at all.
    expect(read(metaDoc({ build: BUILD.toUpperCase() })).data).toBeUndefined();
    expect(checkBuild(undefined)).toMatchObject({ check: 'api build', ok: false, detail: 'no valid meta document' });
  });
});

describe('api stations', () => {
  const read = (doc: unknown = stationsDoc(), over: Partial<Page> = {}) =>
    readApi(apiPage(doc, STATIONS_CACHE, over), Stations, STATIONS_CACHE);

  it('passes: 200, exactly max-age=300, the Stations contract, a series of NL-1, DE-1, FR-1, CH-1, DE-7 and LU-1', () => {
    expect(checkStations(read())).toEqual({
      check: 'api stations',
      ok: true,
      detail:
        '200, public, max-age=300, the Stations contract, 6 stations, 2 NL-1 and 1 DE-1 and 1 FR-1 and 1 CH-1 and 1 DE-7 and 1 LU-1 series',
    });
  });

  it('fails without a DE-1 or an NL-1 series, on the /meta Cache-Control, on a bad body and on a network error', () => {
    const only = (id: string, source: string) =>
      Stations.parse({ stations: [stationDoc(id, 'NL', [seriesDoc(1, source, 'H')])] });
    expect(checkStations(read(only('nl.rws.lobith.bovenrijn.tolkamer', 'NL-1')))).toMatchObject({
      ok: false,
      detail:
        'no station has a DE-1 series; no station has a FR-1 series; no station has a CH-1 series; no station has a DE-7 series; no station has a LU-1 series',
    });
    expect(checkStations(read(only('de.wsv.kaub', 'DE-1'))).detail).toBe(
      'no station has a NL-1 series; no station has a FR-1 series; no station has a CH-1 series; no station has a DE-7 series; no station has a LU-1 series',
    );
    expect(checkStations(read(Stations.parse({ stations: [] }))).detail).toBe(
      'no station has a NL-1 series; no station has a DE-1 series; no station has a FR-1 series; no station has a CH-1 series; no station has a DE-7 series; no station has a LU-1 series',
    );
    // A source's series alone are not enough: each of FR-1 and CH-1 is needed (P5a), DE-7 and LU-1 too (P5b).
    for (const [id, source] of [
      ['fr.sandre.A701061001', 'FR-1'],
      ['ch.bafu.2289', 'CH-1'],
      ['de.lanuk.2768898001', 'DE-7'],
      ['lu.age.Perl', 'LU-1'],
    ] as const)
      expect(checkStations(read({ stations: stationsDoc().stations.filter((st) => st.id !== id) }))).toMatchObject({
        ok: false,
        detail: `no station has a ${source} series`,
      });
    expect(checkStations(readApi(apiPage(stationsDoc(), META_CACHE), Stations, STATIONS_CACHE))).toMatchObject({
      ok: false,
      detail: 'cache-control "public, max-age=60"',
    });
    expect(checkStations(read({ stations: [{ id: 1 }] }))).toMatchObject({
      ok: false,
      detail: 'not the contract document',
    });
    expect(checkStations(read(stationsDoc(), { status: 404 })).detail).toBe('status 404');
    expect(checkStations(readApi('timeout', Stations, STATIONS_CACHE)).detail).toBe('timeout');
  });
});

describe('api snapshot', () => {
  it('asks for the 10-minute floor of the SERVER clock, now, 6 h and 3 d back, as YYYY-MM-DDTHH:MMZ', () => {
    expect(snapshotAt(SERVER_NOW, 0)).toEqual({ ms: NOW_MS, path: '/api/v1/snapshot?t=2026-10-02T12:00Z' });
    expect(snapshotAt(SERVER_NOW, H6_ASK.back)).toEqual({
      ms: NOW_MS - 6 * 3_600_000,
      path: '/api/v1/snapshot?t=2026-10-02T06:00Z',
    });
    expect(snapshotAt(SERVER_NOW, D3_ASK.back)?.path).toBe('/api/v1/snapshot?t=2026-09-29T12:00Z');
    // On the edge of a bucket, and across midnight.
    expect(snapshotAt('2026-10-02T12:09:59.999Z', 0)?.path).toBe('/api/v1/snapshot?t=2026-10-02T12:00Z');
    expect(snapshotAt('2026-10-02T12:10:00.000Z', 0)?.path).toBe('/api/v1/snapshot?t=2026-10-02T12:10Z');
    expect(snapshotAt('2026-10-02T00:04:00.000Z', H6_ASK.back)?.path).toBe('/api/v1/snapshot?t=2026-10-01T18:00Z');
    // Only the server's time counts: a verifier years off still asks for what the server thinks is now.
    expect(snapshotAt('2031-01-01T00:00:30.000Z', 0)?.path).toBe('/api/v1/snapshot?t=2031-01-01T00:00Z');
    for (const bad of [undefined, '', 'yesterday']) expect(snapshotAt(bad, 0)).toBeUndefined();
    expect(SNAPSHOT_ASKS.map((a) => [a.name, a.back])).toEqual([
      ['now', 0],
      ['6h', 21_600_000],
      ['3d', 259_200_000],
    ]);
  });

  it('passes with the Cache-Control of its age: now 60 + stale-while-revalidate, 6 h 600, 3 d 86400', () => {
    expect(NOW_ASK.cache).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(H6_ASK.cache).toBe('public, max-age=600');
    expect(D3_ASK.cache).toBe('public, max-age=86400');
    for (const ask of SNAPSHOT_ASKS) {
      const ms = snapshotAt(SERVER_NOW, ask.back)?.ms ?? 0;
      expect(checkSnapshot(ask, snapRead(ask, ms))).toMatchObject({
        check: `api snapshot ${ask.name}`,
        ok: true,
        detail: /^200, the Snapshot contract, t 2026-/,
      });
    }
  });

  it('fails on any other Cache-Control, so each age class is told apart', () => {
    const cache = (ask: SnapshotAsk, other: string) =>
      checkSnapshot(
        ask,
        snapRead(ask, NOW_MS, { headers: { 'content-type': 'application/json', 'cache-control': other } }),
      );
    expect(cache(NOW_ASK, H6_ASK.cache)).toMatchObject({ ok: false, detail: 'cache-control "public, max-age=600"' });
    expect(cache(NOW_ASK, 'public, max-age=60').ok).toBe(false);
    expect(cache(H6_ASK, NOW_ASK.cache).ok).toBe(false);
    expect(cache(H6_ASK, D3_ASK.cache).ok).toBe(false);
    expect(cache(D3_ASK, H6_ASK.cache).ok).toBe(false);
    expect(cache(D3_ASK, 'no-store').detail).toBe('cache-control "no-store"');
  });

  it('"now" accepts the 600 s class only when the Date header shows the server moved into the next bucket since /meta', () => {
    const served = (date: string | undefined, cache: string) =>
      checkSnapshot(
        NOW_ASK,
        snapRead(NOW_ASK, NOW_MS, {
          headers: {
            'content-type': 'application/json',
            'cache-control': cache,
            ...(date === undefined ? {} : { date }),
          },
        }),
      );
    // The same bucket (12:09:58): "now" is still current, so 600 is wrong.
    expect(served('Fri, 02 Oct 2026 12:09:58 GMT', H6_ASK.cache).ok).toBe(false);
    expect(served('Fri, 02 Oct 2026 12:09:58 GMT', NOW_ASK.cache).ok).toBe(true);
    // The next bucket (12:10:02): the instant asked for is now a past one, 600.
    expect(served('Fri, 02 Oct 2026 12:10:02 GMT', H6_ASK.cache).ok).toBe(true);
    expect(served('Fri, 02 Oct 2026 12:10:02 GMT', NOW_ASK.cache).ok).toBe(false);
    // No Date header, or one that is no date: no tolerance.
    expect(served(undefined, H6_ASK.cache).ok).toBe(false);
    expect(served('soon', H6_ASK.cache).ok).toBe(false);
    // 6 h and 3 d never get the tolerance.
    const late = {
      headers: {
        'content-type': 'application/json',
        'cache-control': NOW_ASK.cache,
        date: 'Fri, 02 Oct 2026 12:10:02 GMT',
      },
    };
    expect(checkSnapshot(H6_ASK, snapRead(H6_ASK, NOW_MS - 6 * 3_600_000, late)).ok).toBe(false);
  });

  it('fails when t is not the instant asked for, when the body is off the contract and on a status or network error', () => {
    expect(checkSnapshot(NOW_ASK, snapRead(NOW_ASK, NOW_MS, {}, snapshotDoc(NOW_MS - 600_000)))).toMatchObject({
      ok: false,
      detail: 't is not the instant asked for',
    });
    expect(checkSnapshot(NOW_ASK, snapRead(NOW_ASK, NOW_MS, {}, { t: new Date(NOW_MS).toISOString() }))).toMatchObject({
      ok: false,
      detail: 'not the contract document',
    });
    expect(
      checkSnapshot(NOW_ASK, snapRead(NOW_ASK, NOW_MS, { status: 400 }, { error: 'bad_parameter' })),
    ).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/^status 400/),
    });
    expect(checkSnapshot(NOW_ASK, readSnapshot(NOW_ASK, NOW_MS, 'ECONNRESET'))).toEqual({
      check: 'api snapshot now',
      ok: false,
      detail: 'ECONNRESET',
    });
    // A t with seconds or milliseconds is the same instant.
    expect(checkSnapshot(NOW_ASK, snapRead(NOW_ASK, NOW_MS, {}, { t: '2026-10-02T12:00:00Z', values: [] })).ok).toBe(
      true,
    );
  });

  it('is a FAIL with the reason when /meta gave no server time', () => {
    for (const ask of SNAPSHOT_ASKS)
      expect(checkSnapshot(ask, undefined)).toEqual({
        check: `api snapshot ${ask.name}`,
        ok: false,
        detail: 'no server time from /api/v1/meta',
      });
  });
});

describe('api states and class coverage (P7b)', () => {
  const BASIS = { source: 'DE-1', kind: 'operational', measure: 'stage', ref: 'MNW/MHW', label: 'WSV MNW 2010-2020' };
  const AREA = { source: 'FR-5', kind: 'area', measure: 'area', ref: 'x', label: 'Vigicrues' };
  const val = (over: Record<string, unknown> = {}) => ({
    series: 1,
    ts: '2026-10-02T11:50:00Z',
    value: 1,
    qc: 0,
    ageSeconds: 600,
    state: 'normal',
    basis: BASIS,
    section: false,
    ...over,
  });
  const snap = (...values: unknown[]) => Snapshot.parse({ t: '2026-10-02T12:00:00Z', values });
  const raw = (...values: unknown[]) => ({ t: '2026-10-02T12:00:00Z', values }) as unknown as Snapshot;

  it('counts classed, section and no_ref values', () => {
    expect(
      checkStates(
        snap(
          val(),
          val({ series: 2, state: 'high', basis: AREA, section: true }),
          val({ series: 3, state: 'no_ref', basis: null }),
        ),
      ),
    ).toEqual({ check: 'api states', ok: true, detail: '3 values, 2 classed, 1 by section, 1 no_ref' });
  });

  it('passes with no values and fails without a snapshot', () => {
    expect(checkStates(snap()).ok).toBe(true);
    expect(checkStates(undefined).ok).toBe(false);
  });

  it.each([
    ['a basis with no_ref', val({ state: 'no_ref' })],
    ['no basis with a state', val({ basis: null })],
    ['a section without an area basis', val({ section: true })],
    ['an area basis without section', val({ basis: AREA })],
    [
      'a section with an area beside it',
      val({ state: 'high', basis: AREA, section: true, area: { state: 'high', basis: AREA } }),
    ],
    ['nap and zero together', val({ nap: { m: 1, pm: 0.1 }, zero: { m: 1, datum: 'IGN69' } })],
  ])('fails on %s', (_, v) => {
    expect(checkStates(raw(v))).toMatchObject({ ok: false });
  });

  it('never prints a hostile label', () => {
    const r = checkStates(raw(val({ basis: { ...BASIS, label: '<img onerror=x>' }, section: true })));
    expect(r.detail).not.toContain('img');
  });

  it('owner leak and owner ids catch an owner basis source in a snapshot or health body', () => {
    const body = JSON.stringify({ values: [val({ basis: { ...BASIS, source: 'LU-4' } })] });
    expect(checkOwnerLeak({ '/api/v1/snapshot now': body }, leakTerms(registry)).ok).toBe(false);
    expect(checkOwnerIds({ '/api/v1/snapshot now': body }, ['LU-4']).ok).toBe(false);
  });

  const share = (stations: number, classed: number, by_section = 0) => ({
    stations,
    classed,
    by_section,
    ratio: stations === 0 ? null : classed / stations,
  });
  it('class coverage prints numbers and country codes', () => {
    const classification = {
      t: '2026-10-02T12:00:00Z',
      mode: 'state',
      tier1: share(10, 7, 1),
      first_release: share(10, 7),
      countries: [{ country: 'DE', tier1: share(4, 3), first_release: share(4, 3) }],
    } as HealthSources['classification'];
    expect(checkClassCoverage(sourcesDoc({ classification }))).toEqual({
      check: 'class coverage',
      ok: true,
      detail: 'tier-1 70.0% (1 by section), mode state; DE 3/4',
    });
  });

  it('class coverage passes with no stations and fails when null or absent', () => {
    const empty = {
      t: '2026-10-02T12:00:00Z',
      mode: 'dh',
      tier1: share(0, 0),
      first_release: share(0, 0),
      countries: [],
    } as HealthSources['classification'];
    expect(checkClassCoverage(sourcesDoc({ classification: empty }))).toMatchObject({ ok: true });
    expect(checkClassCoverage(sourcesDoc())).toMatchObject({ ok: false });
    expect(checkClassCoverage(undefined)).toMatchObject({ ok: false });
  });
});

describe('forecast NL-1 and forecast coverage (P8a)', () => {
  const run = (over: Partial<NonNullable<SourceRow['forecast']>> = {}) => ({
    issued_at: ago(6 * 3600_000),
    run_age_s: 6 * 3600,
    series: 71,
    current: 71,
    late: null,
    ...over,
  });
  const nl = (forecast: SourceRow['forecast']) => sourcesDoc({ sources: [de1(), nl1({ forecast })] });

  it('forecast NL-1 passes for a run within a day and a bit, whatever its hour of the day, and prints numbers only', () => {
    expect(checkForecastNl1(nl(run()))).toEqual({
      check: 'forecast NL-1',
      ok: true,
      detail: `71 of 71 series have a current run, the newest was issued 6.0 h ago (${ago(6 * 3600_000)})`,
    });
    // RWS issues one run a day: 20 hours since the newest series' run is the normal worst case, not a failure.
    expect(checkForecastNl1(nl(run({ run_age_s: 20 * 3600 })))).toMatchObject({ ok: true });
    expect(FORECAST_NL1_MAX_AGE_S).toBe(30 * 3600);
  });

  it('forecast NL-1 fails with no run, an old run, too few current series, no series, no NL-1 or no document', () => {
    expect(checkForecastNl1(nl(null))).toMatchObject({ ok: false, detail: 'NL-1 has stored no forecast run yet' });
    expect(checkForecastNl1(nl(run({ run_age_s: FORECAST_NL1_MAX_AGE_S + 1 })))).toMatchObject({
      ok: false,
      detail: expect.stringContaining('over 30 h old'),
    });
    const few = Math.ceil(71 * FORECAST_NL1_CURRENT_MIN) - 1;
    expect(checkForecastNl1(nl(run({ current: few })))).toMatchObject({
      ok: false,
      detail: expect.stringContaining('current run'),
    });
    expect(checkForecastNl1(nl(run({ series: 0, current: 0 })))).toMatchObject({ ok: false });
    expect(checkForecastNl1(sourcesDoc())).toMatchObject({ ok: false, detail: expect.stringContaining('not listed') });
    expect(checkForecastNl1(undefined)).toMatchObject({ ok: false });
  });

  const ids = reachIds();
  const reach = (id: string, over: Partial<ForecastCoverage['reaches'][number]> = {}) => ({
    id,
    names: { nl: id, en: id },
    stations: 2,
    covered: 1,
    sources: ['NL-1'],
    no_official_forecast: false,
    after_permission: [],
    none_publishes: [],
    ...over,
  });
  const coverage = (over: Partial<ForecastCoverage> = {}, reaches = ids.map((id) => reach(id))): ForecastCoverage => ({
    t: '2026-10-03T12:00:00.000Z',
    total: { stations: reaches.length * 2, covered: reaches.length },
    countries: [{ country: 'NL', stations: reaches.length * 2, covered: reaches.length }],
    reaches,
    other: { stations: 0, covered: 0 },
    ...over,
  });
  const owners = ownerSourceIds(registry);

  it('the text of every reach row (names, agencies) holds no owner term: the owner leak check cannot trip on it', () => {
    const rows = ForecastReaches.parse(
      parse(readFileSync(join(repoRoot, 'registry/forecast-reaches.yaml'), 'utf8'), { maxAliasCount: 0 }),
    ).reaches;
    const text = JSON.stringify(rows.map((r) => [r.id, r.names, r.after_permission, r.none_publishes]));
    expect(leaks(text, ownerTerms(registry))).toEqual([]);
    expect(leaks(text, ['BfG'])).toEqual([]);
  });

  it('the reach ids are the 15 rows of registry/forecast-reaches.yaml, in order', () => {
    expect(ids).toHaveLength(15);
    expect(ids[0]).toBe('swiss-rhine-aare');
    expect(ids.at(-1)).toBe('ems-vecht');
  });

  it('forecast coverage passes on a report of the registry rows and prints counts only', () => {
    const c = coverage();
    const none = reach('x', { no_official_forecast: true, sources: [], after_permission: ['LfU RLP'] });
    const withNone = coverage(
      {},
      ids.map((id, i) => (i === 2 ? { ...none, id } : reach(id))),
    );
    expect(checkForecastCoverage(sourcesDoc({ forecast_coverage: c }), owners)).toEqual({
      check: 'forecast coverage',
      ok: true,
      detail:
        '15 of 30 first-release stations have a current run, 15 reaches (0 with no official forecast), 0 stations in no reach',
    });
    expect(checkForecastCoverage(sourcesDoc({ forecast_coverage: withNone }), owners).detail).toContain(
      '(1 with no official forecast)',
    );
    expect(checkForecastCoverage(sourcesDoc({ forecast_coverage: withNone }), owners).ok).toBe(true);
  });

  it('forecast coverage fails when null or absent, with other reaches, or with a bare no-forecast reach', () => {
    expect(checkForecastCoverage(sourcesDoc(), owners)).toMatchObject({ ok: false });
    expect(checkForecastCoverage(undefined, owners)).toMatchObject({ ok: false });
    const fewer = coverage(
      {},
      ids.slice(1).map((id) => reach(id)),
    );
    expect(checkForecastCoverage(sourcesDoc({ forecast_coverage: fewer }), owners).detail).toContain(
      'not those of registry/forecast-reaches.yaml',
    );
    const bare = coverage(
      {},
      ids.map((id, i) => (i === 0 ? reach(id, { no_official_forecast: true, sources: [] }) : reach(id))),
    );
    expect(checkForecastCoverage(sourcesDoc({ forecast_coverage: bare }), owners).detail).toContain(
      'say nothing of what could change it',
    );
  });

  it('forecast coverage fails on any owner source ID, in a value or a key, and on BfG, and passes on AGE and SPW', () => {
    const named = (id: string) =>
      coverage(
        {},
        ids.map((r, i) => (i === 3 ? reach(r, { sources: [id] }) : reach(r))),
      );
    for (const id of ['DE-2', 'DE-3', 'LU-3', 'LU-4', 'LU-2', 'BE-3']) {
      expect(owners, id).toContain(id);
      const r = checkForecastCoverage(sourcesDoc({ forecast_coverage: named(id) }), owners);
      expect(r.ok, id).toBe(false);
      expect(r.detail, id).toContain(id);
    }
    const agency = coverage(
      {},
      ids.map((r, i) => (i === 3 ? reach(r, { after_permission: ['BfG'] }) : reach(r))),
    );
    expect(checkForecastCoverage(sourcesDoc({ forecast_coverage: agency }), owners)).toMatchObject({ ok: false });
    const allowed = coverage(
      {},
      ids.map((r, i) =>
        i === 3 ? reach(r, { after_permission: ['AGE', 'LfU RLP'], none_publishes: ['SPW'] }) : reach(r),
      ),
    );
    expect(checkForecastCoverage(sourcesDoc({ forecast_coverage: allowed }), owners)).toMatchObject({ ok: true });
  });
});

describe('forecast CH-4 (P8b)', () => {
  const run = (over: Partial<NonNullable<SourceRow['forecast']>> = {}) => ({
    issued_at: ago(3 * 3600_000),
    run_age_s: 3 * 3600,
    series: 28,
    current: 28,
    late: null,
    ...over,
  });
  const ch = (forecast: SourceRow['forecast']) => sourcesDoc({ sources: [de1(), de1({ id: 'CH-4', forecast })] });

  it('passes for a run within 12 h and a run on every expected series, and prints numbers only', () => {
    expect(checkForecastCh4(ch(run()), 28, 'public')).toEqual({
      check: 'forecast CH-4',
      ok: true,
      detail: `28 of 28 expected series have a run, the newest was issued 3.0 h ago (${ago(3 * 3600_000)})`,
    });
    // BAFU starts a run every 2 to 6 hours and the capture is hourly: 7 h is the worst case, 12 h is the limit.
    expect(checkForecastCh4(ch(run({ run_age_s: FORECAST_CH4_MAX_AGE_S })), 28, 'public')).toMatchObject({ ok: true });
    expect(FORECAST_CH4_MAX_AGE_S).toBe(12 * 3600);
    // More series than expected (a station that began to answer) never fails.
    expect(checkForecastCh4(ch(run({ series: 29 })), 28, 'public')).toMatchObject({ ok: true });
  });

  it('fails on a stale run, on too few series, and says which', () => {
    const stale = checkForecastCh4(ch(run({ run_age_s: FORECAST_CH4_MAX_AGE_S + 1 })), 28, 'public');
    expect(stale).toMatchObject({ ok: false, detail: expect.stringContaining('the newest run is over 12 h old') });
    expect(stale.detail).not.toContain('no run');
    const few = checkForecastCh4(ch(run({ series: 27 })), 28, 'public');
    expect(few).toMatchObject({ ok: false, detail: expect.stringContaining('27 of 28 expected series') });
    expect(few.detail).toContain('1 expected series have no run');
    expect(few.detail).not.toContain('old');
    const both = checkForecastCh4(ch(run({ series: 0, current: 0, run_age_s: 30 * 3600 })), 28, 'public');
    expect(both.detail).toContain('over 12 h old');
    expect(both.detail).toContain('28 expected series have no run');
  });

  it('fails with no forecast, no CH-4 or no document', () => {
    expect(checkForecastCh4(ch(null), 28, 'public')).toMatchObject({
      ok: false,
      detail: 'CH-4 has stored no forecast run yet',
    });
    expect(checkForecastCh4(sourcesDoc(), 28, 'public')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('not listed'),
    });
    expect(checkForecastCh4(undefined, 28, 'public')).toMatchObject({ ok: false });
  });

  it('passes and says why when CH-4 is not public in the registry (a C13 objection, review F2)', () => {
    expect(checkForecastCh4(undefined, 28, 'owner')).toMatchObject({
      ok: true,
      detail: expect.stringContaining('owner'),
    });
    expect(checkForecastCh4(sourcesDoc(), 28, 'public')).toMatchObject({ ok: false });
  });

  it('expects the stations of registry/seed/ch-4.csv with a primary, non-off CH-1 series, less the 404 stations', {
    timeout: 30_000,
  }, () => {
    const seed = readSeed(REGISTRY_DIR, 'ch-4').map((r) => r.id);
    expect(seed).toHaveLength(54);
    expect(CH4_NO_FORECAST).toHaveLength(14);
    expect(new Set(CH4_NO_FORECAST).size).toBe(14);
    for (const id of CH4_NO_FORECAST) expect(seed, id).toContain(id);
    // 54 seeded, 15 of them `off` (non-Rhine water bodies, 3 of those are in the 404 list), 11 more with no body.
    expect(ch4ExpectedSeries()).toBe(28);
    expect(checkForecastCh4(ch(run({ series: 28 })))).toMatchObject({ ok: true });
    expect(checkForecastCh4(ch(run({ series: 27 })))).toMatchObject({ ok: false });
  });

  it('computes the count: Q before W, primary only, never off, no CH-1 series or a 404 station is not counted', () => {
    const row = (key: string, over: Partial<{ source: string; role: string; audience: string }> = {}) => ({
      source: 'CH-1',
      provider_key: key,
      role: 'primary',
      audience: 'public',
      ...over,
    });
    const seed = ['2091', '2016', '2018', '2029', '2030', '2034', '2044', '2056', '9999', '2004'].map((id) => ({ id }));
    const stations = [
      row('2091/Q'),
      row('2091/W'), // beside its Q: one station, counted once
      row('2016/W'), // a lake-style station with W only
      row('2018/Q', { audience: 'off' }),
      row('2018/W'), // Q is off: the run would go to Q, so W does not rescue it
      row('2029/Q', { role: 'secondary' }),
      row('2030/Q', { source: 'CH-2' }), // another source's series with that key
      row('2034/Q'),
      row('2044/Q'),
      row('2004/W'), // in the 404 list
    ];
    // Counted: 2091, 2016, 2034, 2044. Not: 2018 (Q off), 2029 (secondary), 2030 (no CH-1 series), 2056 and 9999
    // (no row), 2004 (answers 404).
    expect(ch4ExpectedSeries(seed, stations)).toBe(4);
    expect(ch4ExpectedSeries([], stations)).toBe(0);
    expect(ch4ExpectedSeries(seed, [])).toBe(0);
  });
});

describe('api openapi and api params', () => {
  it('openapi passes for a 3.1.0 document with exactly max-age=300', () => {
    const read = (doc: unknown, cache = OPENAPI_CACHE, over: Partial<Page> = {}) =>
      readApi(apiPage(doc, cache, over), OpenApi31, OPENAPI_CACHE);
    expect(checkOpenapi(read({ openapi: '3.1.0', info: { title: 'x' }, paths: {} }))).toEqual({
      check: 'api openapi',
      ok: true,
      detail: '200, public, max-age=300, openapi 3.1.0',
    });
    expect(checkOpenapi(read({ openapi: '3.0.3' })).ok).toBe(false);
    expect(checkOpenapi(read({ swagger: '2.0' })).detail).toBe('not the contract document');
    expect(checkOpenapi(read('[]')).ok).toBe(false);
    expect(checkOpenapi(read({ openapi: '3.1.0' }, 'public, max-age=60'))).toMatchObject({
      ok: false,
      detail: 'cache-control "public, max-age=60"',
    });
    expect(checkOpenapi(read({ openapi: '3.1.0' }, OPENAPI_CACHE, { status: 404 })).detail).toBe('status 404');
    expect(checkOpenapi(readApi('timeout', OpenApi31, OPENAPI_CACHE)).detail).toBe('timeout');
  });

  const bad = (over: Partial<Page> = {}): Page => ({
    status: 400,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: '{"error":"unknown_parameter"}',
    ...over,
  });

  it('params passes for the fixed 400 body with no-store', () => {
    expect(checkApiParams(bad())).toEqual({ check: 'api params', ok: true, detail: '400, the fixed body, no-store' });
  });

  it('params fails on another status or body (not echoing the request), a cacheable 400 and a network error', () => {
    expect(checkApiParams(bad({ status: 200 })).detail).toBe('status 200, want 400');
    expect(checkApiParams(bad({ body: '{"error":"bad_parameter"}' })).detail).toBe(
      'the body is not the fixed 400 body',
    );
    expect(checkApiParams(bad({ body: '{"error":"unknown_parameter","x":"1"}' })).ok).toBe(false);
    expect(checkApiParams(bad({ headers: { 'cache-control': 'public, max-age=60' } })).detail).toBe(
      'cache-control "public, max-age=60"',
    );
    expect(checkApiParams(bad({ headers: {} })).detail).toBe('cache-control null');
    expect(checkApiParams('ECONNRESET')).toEqual({ check: 'api params', ok: false, detail: 'ECONNRESET' });
  });
});

describe('noindex', () => {
  const answer = (status: number, tag: string | null = 'noindex'): Page => ({
    status,
    headers: tag === null ? {} : { 'x-robots-tag': tag },
    body: '',
  });
  const all = (over: Record<string, Page | string> = {}): Record<string, Page | string> => ({
    '/': answer(200),
    '/en/': answer(200),
    '/api': answer(404),
    '/tiles': answer(404),
    ...over,
  });

  it('passes for noindex on the pages and on the 404s of /api and /tiles', () => {
    expect([...NOINDEX_PATHS]).toEqual(['/', '/en/', '/api', '/tiles']);
    expect(checkNoindex(all())).toMatchObject({ check: 'noindex', ok: true });
  });

  it('names every path that lacks it, whatever its status, and a network error', () => {
    expect(checkNoindex(all({ '/api': answer(404, null) }))).toMatchObject({
      ok: false,
      detail: '/api: x-robots-tag null',
    });
    expect(checkNoindex(all({ '/en/': answer(200, 'noindex, nofollow'), '/tiles': answer(404, 'all') })).detail).toBe(
      '/en/: x-robots-tag "noindex, nofollow"; /tiles: x-robots-tag "all"',
    );
    expect(checkNoindex(all({ '/': 'ECONNRESET' })).detail).toBe('/: ECONNRESET');
    expect(checkNoindex({}).ok).toBe(false);
  });
});

describe('fresh DE-1 and fresh NL-1', () => {
  const at = (ages: Record<number, number>) => snapshotDoc(NOW_MS, ages);
  const NOW = new Date(NOW_MS).toISOString();

  it('passes when one series of the source has a value of 45 minutes or less, naming the count and the smallest age', () => {
    expect(checkFresh('DE-1', at({ 1: 600, 3: 1200 }), stationsDoc(), NOW)).toEqual({
      check: 'fresh DE-1',
      ok: true,
      detail: '1 of 1 DE-1 series have a value, the newest is 1200 s old',
    });
    expect(checkFresh('NL-1', at({ 1: 600, 3: 1200 }), stationsDoc(), NOW)).toMatchObject({
      check: 'fresh NL-1',
      ok: true,
      detail: '1 of 2 NL-1 series have a value, the newest is 600 s old',
    });
  });

  it('judges the youngest series: one fresh series is enough, the limit is 2700 s', () => {
    expect(FRESH_MAX_AGE_S).toBe(2700);
    expect(checkFresh('NL-1', at({ 1: 5000, 2: 300, 3: 99_999 }), stationsDoc(), NOW)).toMatchObject({
      ok: true,
      detail: /^2 of 2 .* the newest is 300 s old$/,
    });
    expect(checkFresh('NL-1', at({ 1: 2700 }), stationsDoc(), NOW).ok).toBe(true);
    expect(checkFresh('NL-1', at({ 1: 2701 }), stationsDoc(), NOW)).toMatchObject({
      ok: false,
      detail: '1 of 2 NL-1 series have a value, the newest is 2701 s old, over 2700 s',
    });
  });

  it('fails when none of the source has a value, even if the other source is fresh', () => {
    expect(checkFresh('DE-1', at({ 1: 60, 2: 60 }), stationsDoc(), NOW)).toEqual({
      check: 'fresh DE-1',
      ok: false,
      detail: 'none of the 1 DE-1 series has a value',
    });
    expect(checkFresh('NL-1', at({}), stationsDoc(), NOW).ok).toBe(false);
    // A value of a series the stations do not list is no value of the source.
    expect(checkFresh('DE-1', at({ 99: 60 }), stationsDoc(), NOW).ok).toBe(false);
    expect(checkFresh('BE-3', at({ 1: 60, 3: 60 }), stationsDoc(), NOW).detail).toBe(
      'none of the 0 BE-3 series has a value',
    );
  });

  it('measures the age at the server’s now, not at the snapshot’s t, which is floored to 10 minutes', () => {
    // meta.now 12:09: a value that is 10,800 s old at t (12:00) is 11,340 s old at the server's now.
    const late = new Date(NOW_MS + 9 * 60_000).toISOString();
    expect(checkFresh('NL-1', at({ 1: 2400 }), stationsDoc(), late)).toMatchObject({
      ok: false,
      detail: '1 of 2 NL-1 series have a value, the newest is 2940 s old, over 2700 s',
    });
    expect(checkFresh('NL-1', at({ 1: 2100 }), stationsDoc(), late)).toMatchObject({ ok: true, detail: /2640 s old$/ });
  });

  it('fresh FR-1 and fresh CH-1 judge their own series (4 and 5), whatever the other sources have', () => {
    expect(checkFresh('FR-1', at({ 1: 60, 3: 60, 4: 900 }), stationsDoc(), NOW)).toEqual({
      check: 'fresh FR-1',
      ok: true,
      detail: '1 of 1 FR-1 series have a value, the newest is 900 s old',
    });
    expect(checkFresh('CH-1', at({ 5: 600 }), stationsDoc(), NOW)).toMatchObject({ check: 'fresh CH-1', ok: true });
    expect(checkFresh('CH-1', at({ 5: 2701 }), stationsDoc(), NOW)).toMatchObject({
      ok: false,
      detail: '1 of 1 CH-1 series have a value, the newest is 2701 s old, over 2700 s',
    });
    expect(checkFresh('FR-1', at({ 1: 60, 3: 60, 5: 60 }), stationsDoc(), NOW)).toEqual({
      check: 'fresh FR-1',
      ok: false,
      detail: 'none of the 1 FR-1 series has a value',
    });
    expect(checkFresh('CH-1', at({ 4: 60 }), stationsDoc(), NOW).ok).toBe(false);
  });

  it('fails without a valid snapshot, stations or meta document', () => {
    expect(checkFresh('DE-1', at({ 3: 60 }), stationsDoc(), undefined).detail).toBe('no valid meta document');
    expect(checkFresh('DE-1', undefined, stationsDoc(), NOW)).toEqual({
      check: 'fresh DE-1',
      ok: false,
      detail: 'no valid snapshot document',
    });
    expect(checkFresh('DE-1', at({ 3: 60 }), undefined, NOW).detail).toBe('no valid stations document');
  });
});

describe('belgian set (catalogue §0.6)', () => {
  const ids = belgianIds();
  const NOW_ISO = new Date(NOW_MS).toISOString();
  /** One BE station per id, each with series 100 + its place in the list. */
  const stationsOf = (list: readonly string[], name = 'Antwerpen'): Stations =>
    Stations.parse({
      stations: list.map((id, i) => ({
        ...stationDoc(id, 'BE', [seriesDoc(100 + i, id.startsWith('nl.') ? 'NL-1' : 'FR-1', 'H')]),
        name,
      })),
    });
  /** A snapshot with the given age (seconds before NOW) for series 100 + i. */
  const snapOf = (ages: Record<number, number>) => snapshotDoc(NOW_MS, ages);
  const ageAll = (age: number, n = ids.length) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [100 + i, age]));
  const run = (list = ids, ages: Record<number, number> = ageAll(1200), stations = stationsOf(list), now = NOW_ISO) =>
    checkBelgianSet(list, stations, snapOf(ages), now);

  it('the 25 points are the 7 NL-1 locations and the 18 partners of registry/seed/fr-1-be.csv, all distinct', () => {
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
    expect(BELGIAN_NL1).toHaveLength(7);
    expect(ids.slice(0, 7)).toEqual(BELGIAN_NL1.map((c) => `nl.rws.${c}`));
    const partners = ids.slice(7);
    expect(partners).toHaveLength(18);
    for (const id of partners) expect(id).toMatch(/^fr\.sandre\.[A-Z][0-9A-Z]{9}$/);
    // Read from the file, not listed in the script: another list gives another set.
    expect(belgianIds([{ code_station: 'X000000001' }]).slice(7)).toEqual(['fr.sandre.X000000001']);
  });

  it('every one of the 25 is a public primary station of the registry on Belgian soil (an id typo here would never pass)', () => {
    type Row = { id: string; country: string; role: string; audience: string };
    const rows = ['nl-1', 'fr-1'].flatMap(
      (file) =>
        (parse(readFileSync(join(repoRoot, `registry/stations/${file}.yaml`), 'utf8')) as { stations: Row[] }).stations,
    );
    for (const id of ids) {
      const of = rows.filter((r) => r.id === id);
      expect(of.length, id).toBeGreaterThan(0);
      for (const r of of) expect([r.country, r.role, r.audience], id).toEqual(['BE', 'primary', 'public']);
    }
  });

  it('passes when all 25 are stations with a value of at most 3 hours', () => {
    expect(BELGIAN_MAX_AGE_S).toBe(10_800);
    expect(BELGIAN_FRESH_PCT).toBe(90);
    expect(run()).toEqual({
      check: 'belgian set',
      ok: true,
      detail: 'present 25/25, fresh 25/25 (a value no older than 3 h)',
    });
  });

  it('90% is the boundary: 23 of 25 fresh pass, 22 fail; 9 of 10 pass', () => {
    const fresh = (n: number) => ({
      ...ageAll(1200, n),
      ...Object.fromEntries(Array.from({ length: 25 - n }, (_, i) => [100 + n + i, 20_000])),
    });
    expect(run(ids, fresh(23))).toMatchObject({ ok: true, detail: expect.stringContaining('fresh 23/25') });
    const low = run(ids, fresh(22));
    expect(low.ok).toBe(false);
    expect(low.detail).toBe(
      `present 25/25, fresh 22/25 (a value no older than 3 h); stale: ${ids.slice(22).join(', ')}`,
    );
    const ten = ids.slice(0, 10);
    expect(run(ten, ageAll(1200, 9), stationsOf(ten))).toMatchObject({
      ok: true,
      detail: expect.stringContaining('fresh 9/10'),
    });
    expect(run(ten, ageAll(1200, 8), stationsOf(ten)).ok).toBe(false);
  });

  it('3 hours is the boundary, measured at the server’s now and not at the snapshot’s t', () => {
    expect(run(ids, ageAll(10_800)).ok).toBe(true);
    expect(run(ids, ageAll(10_801))).toMatchObject({ ok: false, detail: expect.stringContaining('fresh 0/25') });
    // meta.now 12:09: a value of 09:10 is 3 h 0 min 0 s... plus 9 minutes: 11,340 s old at now, 10,800 s at t.
    const late = new Date(NOW_MS + 9 * 60_000).toISOString();
    expect(run(ids, ageAll(10_800), stationsOf(ids), late).ok).toBe(false);
    expect(run(ids, ageAll(10_200), stationsOf(ids), late).ok).toBe(true);
  });

  it('a point that is not a station fails the check, however fresh the others are', () => {
    const one = ids[3] as string;
    const without = ids.filter((id) => id !== one);
    const r = checkBelgianSet(ids, stationsOf(without), snapOf(ageAll(1200)), NOW_ISO);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe(`present 24/25, fresh 24/25 (a value no older than 3 h); missing: ${one}`);
    // Every one of them missing: all named, nothing is fresh.
    const none = checkBelgianSet(ids, Stations.parse({ stations: [] }), snapOf({}), NOW_ISO);
    expect(none.ok).toBe(false);
    expect(none.detail).toContain('present 0/25, fresh 0/25');
    expect(none.detail).toContain(`missing: ${ids.join(', ')}`);
  });

  it('a point is fresh when any of its series has a value; the values of other series do not count', () => {
    const two = Stations.parse({
      stations: [
        stationDoc('nl.rws.antwerpen', 'BE', [seriesDoc(1, 'NL-1', 'H'), seriesDoc(2, 'NL-1', 'Q')]),
        stationDoc('fr.sandre.B400101101', 'BE', [seriesDoc(3, 'FR-1', 'H')]),
      ],
    });
    const list = ['nl.rws.antwerpen', 'fr.sandre.B400101101'];
    expect(checkBelgianSet(list, two, snapOf({ 1: 20_000, 2: 600, 3: 600 }), NOW_ISO)).toMatchObject({
      ok: true,
      detail: 'present 2/2, fresh 2/2 (a value no older than 3 h)',
    });
    // Series 9 belongs to no listed station; series 1 is too old.
    expect(checkBelgianSet(list, two, snapOf({ 1: 20_000, 3: 600, 9: 60 }), NOW_ISO)).toMatchObject({
      ok: false,
      detail: 'present 2/2, fresh 1/2 (a value no older than 3 h); stale: nl.rws.antwerpen',
    });
  });

  it('prints only our own ids and numbers, never a station name', () => {
    const r = run(ids, ageAll(99_999), stationsOf(ids.slice(0, 20), 'PROVIDER-SECRET-TEXT'));
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain('PROVIDER-SECRET-TEXT');
    expect(r.detail).toMatch(/^[A-Za-z0-9 ./,:;()-]+$/);
  });

  it('is a FAIL with the reason when a document is missing, or when there is nothing to look for', () => {
    const doc = snapOf(ageAll(60));
    const stations = stationsOf(ids);
    expect(checkBelgianSet(ids, stations, undefined, NOW_ISO)).toEqual({
      check: 'belgian set',
      ok: false,
      detail: 'no valid snapshot document',
    });
    expect(checkBelgianSet(ids, undefined, doc, NOW_ISO).detail).toBe('no valid stations document');
    expect(checkBelgianSet(ids, stations, doc, undefined).detail).toBe('no valid meta document');
    expect(checkBelgianSet([], stations, doc, NOW_ISO)).toMatchObject({
      ok: false,
      detail: 'no Belgian point to look for',
    });
  });

  it('the --dry-run list states the rule', () => {
    const found = CHECKS.filter((c) => c.startsWith('belgian set:'));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('25 points');
    expect(found[0]).toContain('registry/seed/fr-1-be.csv');
    expect(found[0]).toContain('>= 90%');
    expect(found[0]).toContain('3 h');
  });
});

describe('owner isolation in the data API bodies', () => {
  const terms = leakTerms(registry);
  const bodies = (over: Record<string, string> = {}) => ({
    '/api/v1/meta': JSON.stringify(metaDoc()),
    '/api/v1/stations': JSON.stringify(stationsDoc()),
    '/api/v1/snapshot now': JSON.stringify(snapshotDoc(NOW_MS)),
    '/api/v1/snapshot 6h': JSON.stringify(snapshotDoc(NOW_MS - 6 * 3_600_000)),
    '/api/v1/snapshot 3d': JSON.stringify(snapshotDoc(NOW_MS - 3 * 86_400_000)),
    ...over,
  });

  it('finds nothing in real meta, stations and snapshot bodies', () => {
    expect(checkOwnerLeak(bodies(), terms)).toMatchObject({ check: 'owner leak', ok: true });
  });

  const leaking: [string, string, string, RegExp][] = [
    [
      'an owner source in /meta',
      '/api/v1/meta',
      JSON.stringify(metaDoc({ sources: [{ id: 'BE-3', attribution: [] }] })),
      /meta: BE-3/,
    ],
    [
      'an owner source on a /stations series',
      '/api/v1/stations',
      JSON.stringify(Stations.parse({ stations: [stationDoc('be.x.y', 'BE', [seriesDoc(7, 'LU-2', 'H')])] })),
      /stations: LU-2/,
    ],
    [
      'the owner canary as real prints it, in a snapshot',
      '/api/v1/snapshot now',
      JSON.stringify({
        t: '2026-10-02T12:00:00.000Z',
        values: [{ series: 1, ts: '2026-10-02T11:50:00.000Z', value: 777777.75, qc: 0, ageSeconds: 600 }],
      }),
      /snapshot now: 777777\.75/,
    ],
    [
      'the withheld canary, in an old snapshot',
      '/api/v1/snapshot 3d',
      JSON.stringify({
        t: '2026-09-29T12:00:00.000Z',
        values: [{ series: 1, ts: '2026-09-29T11:50:00.000Z', value: 123456.789, qc: 0, ageSeconds: 600 }],
      }),
      /snapshot 3d: 123456\.789/,
    ],
    [
      'a private_basis key in /meta',
      '/api/v1/meta',
      JSON.stringify({ ...metaDoc(), private_basis: null }),
      /key private_basis/,
    ],
  ];
  it.each(leaking)('fails on %s', (_, label, body, detail) => {
    expect(checkOwnerLeak(bodies({ [label]: body }), terms)).toMatchObject({
      ok: false,
      detail: expect.stringMatching(detail),
    });
  });
});

// P5c (issue #20): the owner sources never show in the public API. `owner sources` reads the counts of
// /api/v1/health/sources, `owner stations` the station list; both pure, on contract documents. `owner health` is
// the half that needs live capture (review SR-8), so the CI deploy job may let only it fail.

describe('owner sources and owner stations (P5c)', () => {
  const ownerIds = ownerSourceIds(registry);
  const readStations = (doc: unknown = stationsDoc(), over: Partial<Page> = {}) =>
    readApi(apiPage(doc, STATIONS_CACHE, over), Stations, STATIONS_CACHE);
  const withStation = (id: string) =>
    ({ stations: [...stationsDoc().stations, stationDoc(id, 'BE', [seriesDoc(9, 'NL-1', 'H')])] }) as unknown;

  it('ownerSourceIds: the owner-audience sources of registry/sources.yaml, and no public one', () => {
    expect(ownerIds).toEqual(expect.arrayContaining(['BE-3', 'LU-2', 'LU-3', 'LU-4', 'DE-2', 'DE-3']));
    for (const id of ['NL-1', 'LU-1', 'DE-1']) expect(ownerIds).not.toContain(id);
    expect(ownerIds.length).toBeGreaterThanOrEqual(OWNER_SOURCES_MIN);
  });

  it('owner sources passes: at least 4 owner sources and none listed, healthy or not (no capture in CI)', () => {
    expect(checkOwnerSources(s(sourcesDoc({ owner_sources: { healthy: 6, total: 6 } })), ownerIds)).toEqual({
      check: 'owner sources',
      ok: true,
      detail: '6 owner sources (at least 4), none listed in sources',
    });
    expect(
      checkOwnerSources(s(sourcesDoc({ owner_sources: { healthy: 4, total: 4 }, sources: [de1(), nl1()] })), ownerIds)
        .ok,
    ).toBe(true);
    expect(checkOwnerSources(s(sourcesDoc({ owner_sources: { healthy: 0, total: 6 } })), ownerIds).ok).toBe(true);
  });

  it.each([
    ['all healthy', { healthy: 6, total: 6 }, true, '6 of 6 owner sources healthy'],
    ['fewer healthy than total', { healthy: 5, total: 6 }, false, '5 of 6 owner sources healthy'],
    ['none healthy', { healthy: 0, total: 6 }, false, '0 of 6 owner sources healthy'],
  ])('owner health on %s', (_, owner_sources, ok, detail) => {
    expect(checkOwnerHealth(s(sourcesDoc({ owner_sources })))).toEqual({ check: 'owner health', ok, detail });
  });

  it('owner health: a 5xx and a network error are FAILs', () => {
    const doc = sourcesDoc({ owner_sources: { healthy: 6, total: 6 } });
    expect(checkOwnerHealth(s(doc, { status: 503 }))).toMatchObject({
      check: 'owner health',
      ok: false,
      detail: expect.stringContaining('status 503'),
    });
    expect(checkOwnerHealth(readApi('ECONNRESET', HealthSources)).ok).toBe(false);
  });

  it.each([
    ['fewer than 4 owner sources', { owner_sources: { healthy: 3, total: 3 } }, '3 owner sources, at least 4 expected'],
    ['no owner source at all', { owner_sources: { healthy: 0, total: 0 } }, '0 owner sources, at least 4 expected'],
  ])('owner sources fails on %s', (_, over, detail) => {
    expect(checkOwnerSources(s(sourcesDoc(over)), ownerIds)).toEqual({
      check: 'owner sources',
      ok: false,
      detail,
    });
  });

  it('owner sources fails on an owner source id in sources[], and the detail counts it without naming it', () => {
    const doc = sourcesDoc({
      owner_sources: { healthy: 6, total: 6 },
      sources: [de1(), de1({ id: 'LU-3' }), de1({ id: 'BE-3' })],
    });
    const r = checkOwnerSources(s(doc), ownerIds);
    expect(r).toEqual({ check: 'owner sources', ok: false, detail: '2 owner sources listed in sources' });
    expect(leaks(r.detail, ownerTerms(registry))).toEqual([]);
  });

  it('owner sources: a 5xx, a non-JSON body, another cache time and a network error are FAILs', () => {
    const doc = sourcesDoc({ owner_sources: { healthy: 6, total: 6 } });
    expect(checkOwnerSources(s(doc, { status: 503 }), ownerIds)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('status 503'),
    });
    expect(checkOwnerSources(readApi(page('<html>'), HealthSources), ownerIds)).toMatchObject({
      ok: false,
      detail: 'no valid health/sources document: not the contract document',
    });
    expect(checkOwnerSources(readApi(page(doc, { status: 500, body: 'oops' }), HealthSources), ownerIds).ok).toBe(
      false,
    );
    expect(
      checkOwnerSources(
        readApi(
          page(doc, { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' } }),
          HealthSources,
        ),
        ownerIds,
      ),
    ).toMatchObject({ ok: false, detail: expect.stringContaining('cache-control') });
    expect(checkOwnerSources(readApi('ECONNRESET', HealthSources), ownerIds)).toEqual({
      check: 'owner sources',
      ok: false,
      detail: 'no valid health/sources document: ECONNRESET',
    });
  });

  it('ownerStationIds: the ids of the owner rows only', () => {
    expect(
      ownerStationIds([
        { id: 'be.spw.a', audience: 'owner' },
        { id: 'lu.age.b', audience: 'public' },
        { id: 'lu.age.c', audience: 'off' },
        { id: 'lu.age-json.d', audience: 'owner' },
      ]),
    ).toEqual(['be.spw.a', 'lu.age-json.d']);
  });

  it('every owner station row of the registry is under an owner station-id prefix, and none is a public id', () => {
    const rows = readRegistry().stations;
    for (const id of ownerStationIds(rows))
      expect(
        OWNER_STATION_PREFIXES.some((p) => id.startsWith(p)),
        id,
      ).toBe(true);
    for (const st of rows.filter((x) => x.audience !== 'owner'))
      expect(
        OWNER_STATION_PREFIXES.some((p) => st.id.startsWith(p)),
        st.id,
      ).toBe(false);
  });

  it('owner stations passes on public stations only, and says how many it checked', () => {
    expect(checkOwnerStations(readStations(), new Set(['be.spw.x']))).toEqual({
      check: 'owner stations',
      ok: true,
      detail: '6 public stations checked, none an owner station',
    });
    expect(checkOwnerStations(readStations(Stations.parse({ stations: [] })), new Set()).ok).toBe(true);
  });

  it.each([
    ['a station id of an owner row of the registry', 'lu.age.owner-row', new Set(['lu.age.owner-row'])],
    ['a be.spw. id', 'be.spw.11', new Set<string>()],
    ['a lu.age-json. id', 'lu.age-json.diekirch', new Set<string>()],
  ])('owner stations fails on %s, without naming it', (_, id, ids) => {
    const r = checkOwnerStations(readStations(withStation(id)), ids);
    expect(r).toEqual({ check: 'owner stations', ok: false, detail: '1 of 7 stations are owner stations' });
    expect(r.detail).not.toContain(id);
  });

  it('owner stations: the prefix is a prefix, not a substring', () => {
    expect(checkOwnerStations(readStations(withStation('nl.be.spw.1')), new Set()).ok).toBe(true);
    expect(checkOwnerStations(readStations(withStation('lu.age-jsonx.1')), new Set()).ok).toBe(true);
  });

  it('owner stations: a 5xx, a non-JSON body and a network error are FAILs; a leak is one whatever the headers say', () => {
    expect(checkOwnerStations(readStations(stationsDoc(), { status: 502 }), new Set())).toMatchObject({
      ok: false,
      detail: expect.stringContaining('status 502'),
    });
    expect(checkOwnerStations(readStations('<html>'), new Set())).toMatchObject({
      ok: false,
      detail: 'no valid stations document: not the contract document',
    });
    expect(checkOwnerStations(readApi('timeout', Stations, STATIONS_CACHE), new Set())).toMatchObject({
      ok: false,
      detail: 'no valid stations document: timeout',
    });
    expect(
      checkOwnerStations(readApi(apiPage(stationsDoc(), META_CACHE), Stations, STATIONS_CACHE), new Set()),
    ).toMatchObject({
      ok: false,
      detail: expect.stringContaining('cache-control'),
    });
    expect(
      checkOwnerStations(readApi(apiPage(withStation('be.spw.1'), META_CACHE), Stations, STATIONS_CACHE), new Set())
        .detail,
    ).toBe('1 of 7 stations are owner stations');
  });

  it('the --dry-run list has exactly one entry for each new check', () => {
    for (const name of ['owner sources', 'owner health', 'owner stations'])
      expect(
        CHECKS.filter((c) => c.startsWith(`${name}:`)),
        name,
      ).toHaveLength(1);
    expect(CHECKS.find((c) => c.startsWith('owner stations:'))).toContain('be.spw. or lu.age-json.');
  });

  it('ci.yml lets only `owner health` fail in the deploy job: `owner sources`, `owner stations` and `owner leak` must PASS', () => {
    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const list = /grep -vE '\^FAIL \(([^)]+)\) '/.exec(ci)?.[1]?.split('|');
    expect(list).toBeDefined();
    expect(list).toContain('owner health');
    expect(list).not.toContain('owner sources');
    expect(list).not.toContain('owner stations');
    expect(list).not.toContain('owner leak');
    for (const name of ['owner leak', 'owner sources', 'owner stations'])
      expect(ci).toContain(`grep -qE '^PASS ${name} '`);
  });
});

describe('health params through Caddy (P4b)', () => {
  it('asks the api for a 400 on a parameter and its JSON 404 on /api/v1/ and /api/v1/x', () => {
    expect([...PARAM_CASES]).toEqual([
      ['/api/v1/health?x=1', 400],
      ['/api/v1/health/sources?x=1', 400],
      ['/api/v1/', 404],
      ['/api/v1/x', 404],
    ]);
  });

  it('fails on a 404 from Caddy (an empty body) where the api answers, and on a 200 for /api/v1/x', () => {
    const good = Object.fromEntries(
      PARAM_CASES.map(([path, status]) => [
        path,
        page(status === 400 ? '{"error":"unknown_parameter"}' : '{"error":"not_found"}', { status }),
      ]),
    );
    expect(checkHealthParams(good).ok).toBe(true);
    const fromCaddy = checkHealthParams({ ...good, '/api/v1/': page('', { status: 404 }) });
    expect(fromCaddy.ok).toBe(false);
    expect(fromCaddy.detail).toBe('/api/v1/: the body is not the fixed 404 body');
    expect(checkHealthParams({ ...good, '/api/v1/x': page('{}', { status: 200 }) }).detail).toBe(
      '/api/v1/x: status 200, want 404',
    );
  });
});

// deploy/web/site.caddy: the routes of the api (P2a, P4b), the tiles and the assets (P3) and the pages (P4b).
// Validated against a real Caddy by hand (the offline run does not start one); the CI deploy job proves them
// end to end.

describe('site.caddy: the api, tile, asset and page routes', () => {
  const site = readFileSync(join(repoRoot, 'deploy/web/site.caddy'), 'utf8');
  /** A one-tab block `<opener> {` up to its closing one-tab brace, without the closing brace. */
  const block = (opener: string): string => {
    const start = site.indexOf(`\n\t${opener} {\n`);
    expect(start, opener).toBeGreaterThanOrEqual(0);
    return site.slice(start, site.indexOf('\n\t}\n', start + 1));
  };
  const lines = (s: string) => s.split('\n').map((l) => l.trim());
  /** The directives of a block, without blank lines and comments. */
  const rules = (opener: string) => lines(block(opener)).filter((l) => l !== '' && !l.startsWith('#'));
  /** What reaches the api: everything under /api/v1/ as sent, no dot segment (the path matcher would fold case). */
  const API_PATH = "`{path}.startsWith('/api/v1/') && !{path}.contains('/.')`";
  const IMMUTABLE = `header Cache-Control "${TILE_CACHE}"`;
  /** The one request a tile file is served for (SR-1, SR2-1). */
  const ONE_RANGE =
    "{header.Range}.matches('^bytes=[0-9]+-[0-9]+$') && {header.If-Range} == '' && {header.If-Match} == '' && {header.If-Unmodified-Since} == ''";

  it('adds no second one-tab header block: the A§12.2 headers are the first and only one', () => {
    expect(site.match(/\n\theader \{\n/g)).toHaveLength(1);
    expect(site.toLowerCase()).not.toContain('access-control-');
  });

  it('proxies GET and HEAD under /api/v1/ to the api: a 1 KB body cap, no Via, no Server, no other upstream (P4b)', () => {
    expect(rules('@api')).toEqual(['@api {', 'method GET HEAD', `expression ${API_PATH}`]);
    // A client's own address headers never reach the api (SR-4): Caddy sets X-Forwarded-For itself. Only Caddy sets
    // X-Degraded (P9a): /api/v1/snapshot alone has the stand-in for an upstream 502, 503 or 504 answer.
    const proxy = ['header_up -Forwarded', 'header_up -X-Real-IP', 'header_down -Server', 'header_down -X-Degraded'];
    expect(rules('handle @api')).toEqual([
      'handle @api {',
      'request_body {',
      'max_size 1KB',
      '}',
      'header -Via',
      "@snapshot expression `{path} == '/api/v1/snapshot'`",
      'handle @snapshot {',
      'reverse_proxy api:8080 {',
      ...proxy,
      '@upstream_5xx status 502 503 504',
      'handle_response @upstream_5xx {',
      'header X-Degraded "1"',
      'header Cache-Control "no-store"',
      'rewrite * /latest.json',
      'root * /srv/rws/public/www/v1',
      'file_server {',
      'precompressed zstd gzip',
      '}',
      '}',
      '}',
      '}',
      'handle {',
      'reverse_proxy api:8080 {',
      ...proxy,
      '}',
      '}',
    ]);
    expect([...site.matchAll(/^\s+reverse_proxy (\S+)/gm)].map((m) => m[1])).toEqual(['api:8080', 'api:8080']);
    // The dead-upstream half (a dial failure or a timeout is a Caddy error): scoped to /api/v1/snapshot, never a
    // site-wide error page (C19, KG-107).
    expect(site.match(/\n\thandle_errors /g)).toHaveLength(1);
    // An error route gets no site header block: it repeats the A§12.2 set byte for byte (review SEC-1), and any
    // other 502, 503 or 504 answers its status without naming Caddy.
    const siteHeaders = rules('header').slice(1);
    expect(siteHeaders).toContain('X-Robots-Tag "noindex"');
    expect(rules('handle_errors 502 503 504')).toEqual([
      'handle_errors 502 503 504 {',
      'header {',
      ...siteHeaders,
      '}',
      "@snapshot_down expression `{http.request.orig_uri.path} == '/api/v1/snapshot'`",
      'handle @snapshot_down {',
      'header X-Degraded "1"',
      'header Cache-Control "no-store"',
      'rewrite * /latest.json',
      'root * /srv/rws/public/www/v1',
      'file_server {',
      'precompressed zstd gzip',
      'status 200',
      '}',
      '}',
      'handle {',
      'respond {err.status_code}',
      '}',
    ]);
  });

  it('answers any method but GET and HEAD with 405 and Allow before every route, any other /api path with 404', () => {
    // One guard for the whole site (SR-3): file_server's own 405 would carry no site header and name Caddy.
    expect(site).toContain('\n\t@write not method GET HEAD\n');
    expect(rules('handle @write')).toEqual(['handle @write {', 'header Allow "GET, HEAD"', 'respond 405']);
    expect(site).not.toContain('@api_method');
    expect(rules('@api_other')).toEqual(['@api_other {', 'path /api /api/*', `not expression ${API_PATH}`]);
    expect(rules('handle @api_other')).toEqual(['handle @api_other {', 'respond 404']);
  });

  it('answers 404 for /status and every status path but the two files', () => {
    expect(rules('handle /status/*')).toEqual(['handle /status/* {', 'respond 404']);
    expect(rules('handle /status')).toEqual(['handle /status {', 'respond 404']);
    expect(site.indexOf('\thandle /status/capture.json {')).toBeLessThan(site.indexOf('\thandle /status/* {'));
  });

  it('serves the manifest with a short TTL, never immutable, from /srv/rws/tiles only', () => {
    expect(lines(block('@tiles_manifest'))).toEqual(
      expect.arrayContaining([
        'method GET HEAD',
        "expression `{path} == '/tiles/manifest.json'`",
        'root /srv/rws/tiles',
        'try_files /manifest.json',
      ]),
    );
    const handle = lines(block('handle @tiles_manifest'));
    expect(handle).toEqual([
      '',
      'handle @tiles_manifest {',
      `header Cache-Control "${MANIFEST_CACHE}"`,
      'uri strip_prefix /tiles',
      'root * /srv/rws/tiles',
      'file_server',
    ]);
  });

  it('serves a tile file only for the exact dated name (TILE_FILE_RE), immutable, with range requests, no browse', () => {
    const matcher = block('@tiles_files');
    const expression = /expression `\{path\}\.matches\('(.+)'\)`/.exec(matcher)?.[1];
    expect(expression).toBe('^/tiles/(basemap|planet-z6)-[0-9]{8}\\\\.pmtiles$');
    expect(lines(matcher)).toEqual(
      expect.arrayContaining(['method GET HEAD', 'root /srv/rws/tiles', 'try_files /{http.request.uri.path.file}']),
    );
    // CEL reads the doubled backslash as one: the regex Caddy compiles.
    const re = new RegExp((expression ?? '').replaceAll('\\\\', '\\'));
    const names = [
      'basemap-20261001.pmtiles',
      'planet-z6-20261001.pmtiles',
      'rivers-20261001.pmtiles',
      'BASEMAP-20261001.pmtiles',
      'basemap-2026100.pmtiles',
      'basemap-202610011.pmtiles',
      'basemap-20261001.pmtiles.gz',
      'basemap-20261001.pmtiles\n',
      'basemap-20261001xpmtiles',
      'planet-z2-20261001.pmtiles',
      '.staging/basemap-20261001.pmtiles',
      '../basemap-20261001.pmtiles',
      'x/../basemap-20261001.pmtiles',
      'basemap-20261001.pmtiles/',
      'manifest.json',
      '',
    ];
    for (const name of names) expect(re.test(`/tiles/${name}`), JSON.stringify(name)).toBe(TILE_FILE_RE.test(name));
    for (const path of [
      '/Tiles/basemap-20261001.pmtiles',
      '/tiles//basemap-20261001.pmtiles',
      '/tiles/./basemap-20261001.pmtiles',
      '//tiles/basemap-20261001.pmtiles',
      '/tiles/basemap-20261001.pmtiles?x',
    ])
      expect(re.test(path), path).toBe(false);
    const handle = lines(block('handle @tiles_files'));
    expect(handle).toEqual([
      '',
      'handle @tiles_files {',
      `@one_range expression \`${ONE_RANGE}\``,
      'handle @one_range {',
      IMMUTABLE,
      'uri strip_prefix /tiles',
      'root * /srv/rws/tiles',
      'file_server',
      '}',
      'handle {',
      'respond 416',
      '}',
    ]);
  });

  it('serves a tile file only for one explicit range, what pmtiles.js sends; anything else is a 416 (SR-1)', () => {
    const expression = /@one_range expression `\{header\.Range\}\.matches\('([^']+)'\)/.exec(site)?.[1];
    expect(expression).toBe('^bytes=[0-9]+-[0-9]+$');
    const one = new RegExp(expression ?? '');
    // pmtiles 4.5.0's FetchSource: `bytes=${offset}-${offset + length - 1}`, also for its 416 retry.
    for (const range of ['bytes=0-16383', 'bytes=0-15', 'bytes=127-127', 'bytes=4300000000-4300016383'])
      expect(one.test(range), range).toBe(true);
    const refused = [
      '', // no Range: the whole multi-GB file
      'bytes=0-', // open
      'bytes=-16', // suffix
      'bytes=0-0,2-2', // several ranges: a multipart answer
      'bytes=0-0, 2-2',
      // Two Range fields: Caddy's header placeholder joins them with a comma.
      'bytes=0-0,bytes=2-2',
      `bytes=${Array.from({ length: 20_000 }, (_, i) => `${2 * i}-${2 * i}`).join(',')}`,
      'items=0-15',
      'bytes=0-15\n',
      'bytes = 0-15',
      'bytes=0x0-15',
    ];
    for (const range of refused) expect(one.test(range), range.slice(0, 40)).toBe(false);
  });

  it('serves that range only without If-Range, If-Match or If-Unmodified-Since; the 304 validators stay (SR2-1)', () => {
    // Go's ServeContent answers a range whose If-Range does not match with the whole file (200), and a failed
    // If-Match or If-Unmodified-Since with a 412 that would carry the immutable header; pmtiles.js sends none of
    // them. If-None-Match and If-Modified-Since only ever turn the answer into a 304. Caddy's placeholder is ''
    // for an absent header, and for an empty one, which Go ignores as well.
    const line = site.split('\n').find((l) => l.includes('@one_range expression')) ?? '';
    expect([...line.matchAll(/\{header\.([A-Za-z-]+)\} == ''/g)].map((m) => m[1])).toEqual([
      'If-Range',
      'If-Match',
      'If-Unmodified-Since',
    ]);
    expect(line).not.toMatch(/If-None-Match|If-Modified-Since|\|\||!=/);
  });

  it('answers 404 for every other /tiles path, after the two routes above and before the catch-all', () => {
    expect(site).toContain('\n\t@tiles path /tiles /tiles/*\n');
    expect(lines(block('handle @tiles'))).toEqual(['', 'handle @tiles {', 'respond 404']);
  });

  it('keeps the routes in order: the method guard, healthz, status, api, tiles, dotfiles, assets, the pages last', () => {
    const at = (needle: string) => site.indexOf(needle);
    const order = [
      at('\thandle @write {'),
      at('\thandle /healthz {'),
      at('\thandle /status/capture.json {'),
      at('\thandle /status/* {'),
      at('\thandle /status {'),
      at('\thandle @api {'),
      at('\thandle @api_other {'),
      at('\thandle @tiles_manifest {'),
      at('\thandle @tiles_files {'),
      at('\thandle @tiles_rivers {'),
      at('\thandle @tiles {'),
      at('\thandle @rivers_manifest {'),
      at('\thandle @rivers_reaches {'),
      at('\thandle @rivers_other {'),
      at('\thandle @rivers_download {'),
      at('\thandle @downloads_other {'),
      at('\thandle @dotfiles {'),
      at('\thandle @assets {'),
      at('\thandle @assets_miss {'),
      at('\thandle {\n\t\theader Cache-Control "no-cache"\n\t\troot * /srv/www'),
    ];
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  it('answers 404 for a dotfile under the web root or /assets, with a matcher Caddy does not re-sort', () => {
    // path_regexp, not path: Caddy sorts path-only matchers by their own rule, and a probe of the real
    // Caddy 2.11.4 put `path */.*` after @assets; a regexp keeps its place before @assets and the catch-all.
    expect(site).toContain('\n\t@dotfiles path_regexp /\\.\n');
    expect(lines(block('handle @dotfiles'))).toEqual(['', 'handle @dotfiles {', 'respond 404']);
    // Caddy matches path_regexp on the decoded, cleaned path, as file_server reads it.
    const dot = /\/\./;
    for (const path of [
      '/.env',
      '/.vite/manifest.json',
      '/assets/.secret.js',
      '/assets/map/.DS_Store',
      '/.well-known/x',
    ])
      expect(dot.test(path), path).toBe(true);
    for (const path of ['/', '/index.html', '/en/', '/assets/main-Bj_Syg2T.js', MAP_ASSET_PATH, '/assets/x.y.js'])
      expect(dot.test(decodeURIComponent(path)), path).toBe(false);
  });

  it('keeps the rivers routes (P6b) exact, immutable where dated, and every other path under them a 404', () => {
    // A separate matcher: P3's regex stays as it was (the test above), the same rules for the river tiles.
    const riversExpr = /expression `\{path\}\.matches\('(.+)'\)`/.exec(block('@tiles_rivers'))?.[1];
    expect(riversExpr).toBe('^/tiles/rivers-[0-9]{8}\\\\.pmtiles$');
    expect(rules('handle @tiles_rivers')).toEqual([
      'handle @tiles_rivers {',
      `@one_range_rivers expression \`${ONE_RANGE}\``,
      'handle @one_range_rivers {',
      IMMUTABLE,
      'uri strip_prefix /tiles',
      'root * /srv/rws/public/data/v1/rivers',
      'file_server',
      '}',
      'handle {',
      'respond 416',
      '}',
    ]);
    expect(lines(block('@tiles_rivers'))).toEqual(
      expect.arrayContaining([
        'method GET HEAD',
        'root /srv/rws/public/data/v1/rivers',
        'try_files /{http.request.uri.path.file}',
      ]),
    );
    expect(rules('handle @rivers_manifest')).toEqual([
      'handle @rivers_manifest {',
      `header Cache-Control "${MANIFEST_CACHE}"`,
      'uri strip_prefix /data/v1/rivers',
      'root * /srv/rws/public/data/v1/rivers',
      'file_server',
    ]);
    expect(lines(block('@rivers_manifest'))).toEqual(
      expect.arrayContaining([
        'method GET HEAD',
        "expression `{path} == '/data/v1/rivers/manifest.json'`",
        'try_files /manifest.json',
      ]),
    );
    expect(rules('handle @rivers_reaches')).toEqual([
      'handle @rivers_reaches {',
      IMMUTABLE,
      'uri strip_prefix /data/v1/rivers',
      'root * /srv/rws/public/data/v1/rivers',
      'file_server',
    ]);
    // The download is gzip data: its own Content-Type and no Content-Encoding anywhere (encode skips application/gzip).
    expect(rules('handle @rivers_download')).toEqual([
      'handle @rivers_download {',
      IMMUTABLE,
      'header Content-Type "application/gzip"',
      'uri strip_prefix /downloads',
      'root * /srv/rws/public/downloads',
      'file_server',
    ]);
    expect(
      site
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n'),
    ).not.toMatch(/Content-Encoding/i);
    expect(site).toContain('\n\t@rivers_other path_regexp ^/data/v1/rivers(/|$)\n');
    expect(rules('handle @rivers_other')).toEqual(['handle @rivers_other {', 'respond 404']);
    expect(site).toContain('\n\t@downloads_other path_regexp ^/downloads(/|$)\n');
    expect(rules('handle @downloads_other')).toEqual(['handle @downloads_other {', 'respond 404']);
    // Nothing else of /data/v1 is claimed (P9 owns it), and no route mounts all of /srv/rws/public.
    const code = site
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/\/data\/v1\/(?!rivers)/);
    expect(code).not.toMatch(/root \* \/srv\/rws\/public\s*$/m);
    const reaches = new RegExp(
      /expression `\{path\}\.matches\('(\^\/data\/v1\/rivers\/reaches-.+)'\)`/
        .exec(block('@rivers_reaches'))?.[1]
        ?.replaceAll('\\\\', '\\') ?? '(?!)',
    );
    const dl = new RegExp(
      /expression `\{path\}\.matches\('(\^\/downloads\/.+)'\)`/
        .exec(block('@rivers_download'))?.[1]
        ?.replaceAll('\\\\', '\\') ?? '(?!)',
    );
    expect(reaches.test('/data/v1/rivers/reaches-20261101.json')).toBe(true);
    for (const bad of [
      '/data/v1/rivers/reaches-2026110.json',
      '/data/v1/rivers/Reaches-20261101.json',
      '/data/v1/rivers/reaches-20261101.json.gz',
      '/data/v1/rivers/../x',
    ])
      expect(reaches.test(bad), bad).toBe(false);
    expect(dl.test('/downloads/rivers-20261101.geojson.gz')).toBe(true);
    for (const bad of [
      '/downloads/rivers-20261101.geojson',
      '/downloads/rivers-20261101xgeojson.gz',
      '/downloads/x.gz',
    ])
      expect(dl.test(bad), bad).toBe(false);
  });

  it('keeps encode off the tile files: one encode, scoped by a matcher that excludes /tiles/*', () => {
    expect(lines(block('@compressible'))).toEqual(['', '@compressible {', 'not path /tiles/*']);
    expect(site.match(/^\tencode .*$/gm)).toEqual(['\tencode @compressible zstd gzip']);
  });

  it('serves /assets/* immutable (A§9.1) for an existing file only, and the HTML pages with no-cache (CR-6)', () => {
    expect(lines(block('@assets'))).toEqual(
      expect.arrayContaining(['path /assets/*', 'not path */', 'root /srv/www', 'try_files {path}']),
    );
    expect(lines(block('handle @assets'))).toEqual([
      '',
      'handle @assets {',
      IMMUTABLE,
      'root * /srv/www',
      'file_server',
    ]);
    // The catch-all that serves the HTML pages sets one header: they are revalidated on every use.
    expect(rules('handle').filter((l) => l.startsWith('header'))).toEqual(['header Cache-Control "no-cache"']);
  });

  it('answers 404 for any other /assets path, never the app (an HTML 200 would be cached as the asset; P4b)', () => {
    // A regexp, so that Caddy keeps it after @assets.
    expect(site).toContain('\n\t@assets_miss path_regexp ^/assets(/|$)\n');
    expect(rules('handle @assets_miss')).toEqual(['handle @assets_miss {', 'respond 404']);
    const miss = /^\/assets(\/|$)/;
    for (const path of ['/assets', '/assets/', '/assets/nope', '/assets/nope.js', '/assets/map/x/'])
      expect(miss.test(path), path).toBe(true);
    for (const path of ['/assetsx', '/assets-old/a.js', '/en/assets/x', '/en/', '/'])
      expect(miss.test(path), path).toBe(false);
  });

  it('falls back to the page of its language for an app route, answers 404 for a missing file (P4b)', () => {
    expect(rules('handle')).toEqual([
      'handle {',
      'header Cache-Control "no-cache"',
      'root * /srv/www',
      '@app_en {',
      'path_regexp ^/en/',
      'not file {path} {path}/',
      'not path_regexp \\.[^/]*$',
      '}',
      '@app {',
      'not file {path} {path}/',
      'not path_regexp \\.[^/]*$',
      '}',
      'rewrite @app_en /en/index.html',
      'rewrite @app /index.html',
      '@missing not file {path} {path}/',
      'respond @missing 404',
      'file_server',
    ]);
    // An app route has no dot in its last segment; favicon.ico and robots.txt are missing files, a 404 that
    // keeps the site headers because Caddy's own file_server 404 would carry none (KG-107).
    const dotted = /\.[^/]*$/;
    for (const path of ['/favicon.ico', '/robots.txt', '/en/x.html', '/a/b.c'])
      expect(dotted.test(path), path).toBe(true);
    for (const path of ['/foo', '/en/foo/bar', '/a.b/c']) expect(dotted.test(path), path).toBe(false);
    for (const path of ['/en/', '/en/foo']) expect(/^\/en\//.test(path), path).toBe(true);
    for (const path of ['/en', '/foo', '/english']) expect(/^\/en\//.test(path), path).toBe(false);
  });

  it('has exactly the cache classes no-store, max-age=60, immutable (tile files, assets), no-cache (pages), no browse', () => {
    const cache = [...site.matchAll(/^\s+header Cache-Control "(.*)"$/gm)].map((m) => m[1]);
    // In file order: the status files, (P9a) /runtime-config.json and the degraded stand-in's two halves, the tiles
    // manifest, the basemap tiles, (P6b) the river tiles, the rivers manifest, the reaches file and the download,
    // (P9a) the static publisher's classes (live, recent, slow, immutable, warnings, status), then the assets and the
    // pages.
    expect(cache).toEqual([
      'no-store',
      'no-store',
      'no-cache',
      'no-store',
      'no-store',
      MANIFEST_CACHE,
      TILE_CACHE,
      TILE_CACHE,
      MANIFEST_CACHE,
      TILE_CACHE,
      TILE_CACHE,
      'public, max-age=60, stale-while-revalidate=300',
      'public, max-age=300, stale-while-revalidate=600',
      'public, max-age=300',
      TILE_CACHE,
      'public, max-age=60',
      'public, max-age=30',
      TILE_CACHE,
      'no-cache',
    ]);
    const directives = site.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(directives.join('\n')).not.toMatch(/\bbrowse\b/);
    // The file servers' roots: the status copy, the tiles, the site and (P9a) the publisher's tree, whose `/v1` path
    // is all Caddy mounts of it (never its .tmp or .state); never the parent /srv/rws.
    const roots = [...site.matchAll(/^\s+root \* (\S+)$/gm)].map((m) => m[1]);
    expect(new Set(roots)).toEqual(
      new Set([
        '/srv/rws/public/ops',
        '/srv/rws/tiles',
        '/srv/rws/public/data/v1/rivers',
        '/srv/rws/public/downloads',
        '/srv/rws/public/www',
        '/srv/rws/public/www/v1',
        '/srv/www',
      ]),
    );
  });
});

// The rivers (P6b): the pure checks on synthetic answers.

const RV = '20261101';
const riversEntry = (file: string, bytes: number) => ({ file, sha256: SHA, bytes });
const riversManifestDoc = (previous = false): RiversManifest => {
  const rel = (v: string) => ({
    version: v,
    tag: 'geo-2026-11-01',
    installed_at: '2026-11-05T05:40:12Z',
    tiles: riversEntry(`rivers-${v}.pmtiles`, 6000),
    reaches: riversEntry(`reaches-${v}.json`, 900),
    download: riversEntry(`rivers-${v}.geojson.gz`, 120),
  });
  return { schema_version: 1, current: rel(RV), previous: previous ? rel('20261001') : null };
};
const jsonPage = (doc: unknown, cache: string, over: Partial<Page> = {}): Page => ({
  status: 200,
  headers: { 'content-type': 'application/json', 'cache-control': cache },
  body: typeof doc === 'string' ? doc : JSON.stringify(doc),
  ...over,
});
const reachesDoc = (over: Partial<ReachesFile> = {}): ReachesFile => ({
  schema_version: 1,
  version: RV,
  attribution: '\u00a9 OpenStreetMap contributors',
  attribution_url: 'https://www.openstreetmap.org/copyright',
  licence: 'ODbL-1.0',
  licence_url: 'https://opendatacommons.org/licenses/odbl/1-0/',
  licence_note: 'The river network is derived from OpenStreetMap.',
  osm_replication_timestamp: '2026-10-01T20:22:06Z',
  rivers: [{ id: 'rhine', name_nl: 'Rijn', name_en: 'Rhine', parent_river_id: null, km_direction: 'downstream' }],
  nl_entry_nodes: [],
  reaches: [],
  stations: [
    {
      id: 'nl.rws.lobith',
      river_id: 'rhine',
      reach_id: null,
      km_official: null,
      km_official_system: null,
      km_graph: null,
      km_to_nl_entry: null,
      nl_entry_node: null,
    },
  ],
  travel_times: [],
  ...over,
});
const riversTilesPage = (over: Partial<Page> = {}): Page => ({
  status: 206,
  headers: { 'content-range': 'bytes 0-15/6000', 'cache-control': TILE_CACHE },
  body: `${PMTILES_MAGIC}${'\u0000'.repeat(8)}`,
  ...over,
});
const gz = (text: string): Buffer => gzipSync(Buffer.from(text));
const downloadHead = (over: Partial<Page> = {}): Page => ({
  status: 200,
  headers: { 'content-type': 'application/gzip', 'cache-control': TILE_CACHE, 'content-length': '120' },
  body: '',
  ...over,
});
const downloadPart = (text: string, over: Partial<Page> = {}): Page => {
  const bytes = gz(text);
  return { status: 206, headers: { 'content-type': 'application/gzip' }, body: '', bytes, ...over };
};
const GEOJSON_HEAD =
  '{"type":"FeatureCollection","attribution":"\u00a9 OpenStreetMap contributors","licence":"ODbL-1.0","features":[]}';

describe('verify-prod: the rivers (P6b)', () => {
  const m = riversManifestDoc();

  it('the manifest passes on 200, exactly max-age=60 and the strict contract; else it names the problem', () => {
    const ok = readRiversManifest(jsonPage(m, MANIFEST_CACHE));
    expect(checkRiversManifest(ok)).toEqual({
      check: 'rivers manifest',
      ok: true,
      detail: `200, ${MANIFEST_CACHE}, current ${RV} (geo-2026-11-01), previous none`,
    });
    expect(checkRiversManifest(readRiversManifest(jsonPage(riversManifestDoc(true), MANIFEST_CACHE))).detail).toMatch(
      /previous 20261001$/,
    );
    const stale = readRiversManifest(jsonPage(m, TILE_CACHE));
    expect(stale.manifest).toBeDefined();
    expect(checkRiversManifest(stale)).toMatchObject({
      ok: false,
      detail: `cache-control ${JSON.stringify(TILE_CACHE)}`,
    });
    expect(checkRiversManifest(readRiversManifest(jsonPage({ ...m, extra: 1 }, MANIFEST_CACHE))).ok).toBe(false);
    expect(
      checkRiversManifest(
        readRiversManifest(jsonPage({ ...m, current: { ...m.current, version: '20260101' } }, MANIFEST_CACHE)),
      ).ok,
    ).toBe(false);
    expect(checkRiversManifest(readRiversManifest(jsonPage('', MANIFEST_CACHE, { status: 404 }))).ok).toBe(false);
    expect(checkRiversManifest(readRiversManifest('ECONNRESET'))).toEqual({
      check: 'rivers manifest',
      ok: false,
      detail: 'ECONNRESET',
    });
  });

  it('the overlay: 206, Content-Range with the manifest bytes, immutable, no Content-Encoding, PMTiles v3', () => {
    expect(checkRiversTiles(m, riversTilesPage())).toMatchObject({ check: 'rivers tiles', ok: true });
    for (const over of [
      { status: 200 },
      { headers: { 'content-range': 'bytes 0-15/7', 'cache-control': TILE_CACHE } },
      { headers: { 'content-range': 'bytes 0-15/6000', 'cache-control': MANIFEST_CACHE } },
      { headers: { 'content-range': 'bytes 0-15/6000', 'cache-control': TILE_CACHE, 'content-encoding': 'gzip' } },
      { body: 'NotTiles\u0003' },
    ])
      expect(checkRiversTiles(m, riversTilesPage(over)).ok, JSON.stringify(over)).toBe(false);
    expect(checkRiversTiles(undefined, riversTilesPage()).detail).toBe('no valid manifest');
    expect(checkRiversTiles(m, 'timeout').detail).toBe('timeout');
  });

  it('the reaches file: contract, consistency, version and every station public', () => {
    const ids = new Set(['nl.rws.lobith', 'de.wsv.x']);
    expect(checkRiversReaches(m, jsonPage(reachesDoc(), TILE_CACHE), ids)).toMatchObject({ ok: true });
    expect(checkRiversReaches(m, jsonPage(reachesDoc(), MANIFEST_CACHE), ids).ok).toBe(false);
    expect(checkRiversReaches(m, jsonPage(reachesDoc({ version: '20261001' }), TILE_CACHE), ids).detail).toContain(
      'the manifest says',
    );
    expect(checkRiversReaches(m, jsonPage(reachesDoc(), TILE_CACHE), new Set(['de.wsv.x'])).detail).toBe(
      '1 of 1 stations are not in /api/v1/stations',
    );
    expect(checkRiversReaches(m, jsonPage(reachesDoc(), TILE_CACHE), undefined).ok).toBe(false);
    const dangling = reachesDoc({ stations: [{ ...reachesDoc().stations[0], river_id: 'nope' } as never] });
    expect(checkRiversReaches(m, jsonPage(dangling, TILE_CACHE), ids).detail).toMatch(/1 inconsistencies/);
    expect(checkRiversReaches(m, jsonPage({ ...reachesDoc(), x: 1 }, TILE_CACHE), ids).detail).toMatch(
      /not the contract document/,
    );
    expect(checkRiversReaches(undefined, jsonPage(reachesDoc(), TILE_CACHE), ids).detail).toBe('no valid manifest');
    expect(checkRiversReaches(m, undefined, ids).ok).toBe(false);
  });

  it('the download: gzip data without a transfer coding, immutable, attribution and licence before "features"', () => {
    const range = downloadPart(GEOJSON_HEAD);
    expect(checkRiversDownload(m, downloadHead(), range)).toMatchObject({ check: 'rivers download', ok: true });
    expect(RIVERS_DOWNLOAD_RANGE).toBe('bytes=0-65535');
    const heads: Partial<Page>[] = [
      { headers: { 'content-type': 'application/octet-stream', 'cache-control': TILE_CACHE, 'content-length': '120' } },
      {
        headers: {
          'content-type': 'application/gzip',
          'cache-control': TILE_CACHE,
          'content-length': '120',
          'content-encoding': 'gzip',
        },
      },
      { headers: { 'content-type': 'application/gzip', 'cache-control': MANIFEST_CACHE, 'content-length': '120' } },
      { headers: { 'content-type': 'application/gzip', 'cache-control': TILE_CACHE, 'content-length': '5' } },
      { status: 404 },
    ];
    for (const over of heads)
      expect(checkRiversDownload(m, downloadHead(over), range).ok, JSON.stringify(over)).toBe(false);
    // The text of the start: attribution and licence must precede "features", and the stream may be cut off.
    const late =
      '{"type":"FeatureCollection","features":[],"attribution":"\u00a9 OpenStreetMap contributors","licence":"ODbL-1.0"}';
    expect(checkRiversDownload(m, downloadHead(), downloadPart(late)).detail).toContain('before "features"');
    expect(checkRiversDownload(m, downloadHead(), downloadPart('{"features":[]}')).ok).toBe(false);
    expect(
      checkRiversDownload(m, downloadHead(), downloadPart(GEOJSON_HEAD.replace('ODbL-1.0', 'CC0-1.0'))).detail,
    ).toBe('no licence ODbL-1.0 before "features"');
    const long = gz(`${GEOJSON_HEAD.slice(0, -2)}${',{"type":"Feature"}'.repeat(5000)}]}`);
    const cut = long.subarray(0, Math.floor(long.length / 2));
    expect(checkRiversDownload(m, downloadHead(), { ...range, bytes: cut })).toMatchObject({ ok: true });
    expect(checkRiversDownload(m, downloadHead(), { ...range, bytes: Buffer.from('not gzip') }).detail).toBe(
      'the first bytes do not inflate as gzip',
    );
    expect(checkRiversDownload(m, downloadHead(), { ...range, headers: { 'content-encoding': 'gzip' } }).ok).toBe(
      false,
    );
    expect(checkRiversDownload(m, 'timeout', range).detail).toBe('HEAD: timeout');
    expect(checkRiversDownload(m, downloadHead(), undefined).ok).toBe(false);
    expect(checkRiversDownload(undefined, downloadHead(), range).detail).toBe('no valid manifest');
  });

  it('the attribution: the entry script of the page names the ODbL', () => {
    expect(entryScript('<html><script type="module" crossorigin src="/assets/index-AbC123.js"></script>')).toBe(
      '/assets/index-AbC123.js',
    );
    expect(entryScript('<html><link rel="modulepreload" href="/assets/x.js">')).toBeUndefined();
    const js = (body: string, status = 200): Page => ({ status, headers: {}, body });
    expect(checkRiversAttribution(js('a "ODbL 1.0" b'))).toMatchObject({ check: 'rivers attribution', ok: true });
    expect(checkRiversAttribution(js('nothing')).ok).toBe(false);
    expect(checkRiversAttribution(js('ODbL', 404)).ok).toBe(false);
    expect(checkRiversAttribution(undefined).ok).toBe(false);
    expect(checkRiversAttribution('timeout').detail).toBe('timeout');
  });

  it('the rivers bodies are in the owner leak check: a canary in the reaches file fails it', () => {
    const terms = leakTerms(loadRegistry());
    const body = JSON.stringify(reachesDoc());
    expect(checkOwnerLeak({ '/data/v1/rivers/reaches': body }, terms).ok).toBe(true);
    expect(checkOwnerLeak({ '/data/v1/rivers/reaches': body.replace('Rhine', OWNER_CANARY) }, terms).ok).toBe(false);
  });

  it('the --dry-run list names the five checks once each', () => {
    for (const name of ['rivers manifest', 'rivers tiles', 'rivers reaches', 'rivers download', 'rivers attribution'])
      expect(
        CHECKS.filter((c) => c.startsWith(`${name}:`)),
        name,
      ).toHaveLength(1);
  });
});

describe('owner ids and interval DE-6 (P7a)', () => {
  const doc = (generated_at: string, ok: Record<string, string | null>) =>
    ({
      generated_at,
      specs: Object.entries(ok).map(([spec, last_success]) => ({ source: 'DE-6', spec, last_success })),
      days: [],
      seeds: [],
    }) as unknown as CaptureStatus;
  const at = (min: number) => new Date(Date.UTC(2026, 9, 3, 12, min)).toISOString();
  const both = (gen: number, ls: number | null) =>
    doc(at(gen), {
      'de-6-stations': ls === null ? null : at(ls),
      'de-6-alerts': ls === null ? null : at(ls),
    });

  it('owner ids: whole ids in string values and object keys', () => {
    const ids = ['BE-3', 'LU-4'];
    const ok = { '/h': JSON.stringify({ sources: [{ id: 'DE-1', note: 'BE-33 and XBE-3', 'XBE-3': 1 }] }) };
    expect(checkOwnerIds(ok, ids)).toMatchObject({ check: 'owner ids', ok: true });
    const bad = { '/h': JSON.stringify({ sources: [{ id: 'DE-1', nested: ['x', 'LU-4'] }] }) };
    expect(checkOwnerIds(bad, ids)).toMatchObject({ ok: false, detail: /\/h: LU-4/ });
    // A key is scanned too (review SR-9): `{"BE-3": …}` names the source as plainly as a value would.
    const keyed = { '/h': JSON.stringify({ by_source: { 'DE-1': 2, 'BE-3': 1 } }) };
    expect(checkOwnerIds(keyed, ids)).toMatchObject({ ok: false, detail: /\/h: BE-3/ });
  });

  it('samples without waiting and passes with fresh, advancing successes', async () => {
    const sleeps: number[] = [];
    const docs = [both(0, -5), both(15, 10), both(30, 25)];
    const samples = await sampleCapture(
      async () => docs.shift(),
      async (ms) => void sleeps.push(ms),
    );
    expect(sleeps).toEqual([900_000, 900_000]);
    expect(checkIntervalDe6(samples)).toMatchObject({ ok: true, detail: /de-6-stations 300\/300\/300 s/ });
  });

  it.each([
    ['too old', [both(0, -5), both(15, 3), both(30, 25)], /sample 2 is 720 s old/],
    ['not advancing', [both(0, -5), both(15, -5), both(30, -5)], /did not advance/],
    ['null last_success', [both(0, null), both(15, 10), both(30, 25)], /no last_success/],
    [
      'spec missing',
      [doc(at(0), { 'de-6-stations': at(0) }), both(15, 10), both(30, 25)],
      /de-6-alerts: sample 1 has no such spec/,
    ],
    ['unreadable', [undefined, both(15, 10), both(30, 25)], /unreadable/],
  ])('interval DE-6 fails: %s', (_n, samples, re) => {
    expect(checkIntervalDe6(samples)).toMatchObject({ check: 'interval DE-6', ok: false, detail: re });
  });

  it('the --dry-run list names both', () => {
    for (const name of ['owner ids', 'interval DE-6'])
      expect(CHECKS.filter((c) => c.startsWith(`${name}:`))).toHaveLength(1);
  });
});

describe('verify-prod: the static publisher (P9a)', () => {
  it('a host a public source shares is no owner term in a static file; the tripwire list keeps it', () => {
    // LU-1 (public) and LU-2 to LU-4 (owner) fetch from AGE's host; sources.json names LU-1's provider terms page.
    const terms = staticLeakTerms(registry);
    expect(leakTerms(registry)).toContain('inondations.public.lu');
    expect(terms).not.toContain('inondations.public.lu');
    for (const t of ['LU-2', 'LU-3', 'LU-4', 'BE-3', 'DE-2', 'lu-3-percentile', 'vorhersage.bafg.de', OWNER_CANARY])
      expect(terms).toContain(t);
    expect(leaks('{"licence":{"url":"https://inondations.public.lu/fr/support/aspects-legaux.html"}}', terms)).toEqual(
      [],
    );
    expect(leaks('{"source":"LU-3"}', terms)).toEqual(['LU-3']);
  });

  const accept = { safeParse: (v: unknown) => ({ success: true as const, data: v as { ok?: number } }) };
  const refuse = { safeParse: () => ({ success: false as const }) };
  const file = (doc: unknown, cache: string, type = 'application/json', over: Partial<Page> = {}): Page => ({
    status: 200,
    headers: { 'content-type': type, 'cache-control': cache },
    body: typeof doc === 'string' ? doc : JSON.stringify(doc),
    ...over,
  });
  const live = STATIC_CACHE.live;
  const rd = (data?: unknown, problems: string[] = []): ApiRead<never> =>
    ({ ...(data === undefined ? {} : { data }), problems }) as ApiRead<never>;
  const ok = (name: string, r: { ok: boolean | 'n/a'; check: string }) =>
    expect(r).toMatchObject({ check: name, ok: true });

  describe('readStatic', () => {
    it('passes a 200 with its class, its type and the contract', () => {
      expect(readStatic(file({ ok: 1 }, live), accept, live)).toEqual({ data: { ok: 1 }, problems: [] });
      expect(
        readStatic(file({}, STATIC_CACHE.warnings, `${GEOJSON}; charset=utf-8`), accept, STATIC_CACHE.warnings, GEOJSON)
          .problems,
      ).toEqual([]);
    });
    it.each([
      ['a wrong Cache-Control', file({}, 'public, max-age=60'), /cache-control "public, max-age=60"/],
      [
        'a missing Cache-Control',
        file({}, live, 'application/json', { headers: { 'content-type': 'application/json' } }),
        /cache-control ""/,
      ],
      ['a wrong Content-Type', file({}, live, 'text/html'), /content-type "text\/html"/],
      ['application/json for a geojson file', file({}, live, 'application/json'), /content-type/],
      ['a 404', file({}, live, 'application/json', { status: 404 }), /status 404/],
      ['a network error', 'timeout', /timeout/],
    ])('fails %s', (_n, p, re) => {
      expect(
        readStatic(p, accept, live, _n.includes('geojson') ? GEOJSON : 'application/json').problems.join(';'),
      ).toMatch(re);
    });
    it('fails the contract and an owner term, but still returns the document for the term', () => {
      expect(readStatic(file({}, live), refuse, live).problems).toEqual(['not the contract document']);
      const r = readStatic(file({ note: 'BE-3 here' }, live), accept, live, 'application/json', ['BE-3', 'LU-2']);
      expect(r.problems).toEqual(['owner term BE-3']);
      expect(r.data).toBeDefined();
    });
    it('takes the real WarningsFile and FramesFile contracts', () => {
      const w = {
        type: 'FeatureCollection',
        schemaVersion: 1,
        generatedAt: '2026-10-04T10:00:00Z',
        day: null,
        features: [],
        attribution: [],
      };
      expect(
        readStatic(file(w, STATIC_CACHE.warnings, GEOJSON), WarningsFile, STATIC_CACHE.warnings, GEOJSON).problems,
      ).toEqual([]);
      expect(
        readStatic(
          file({ ...w, day: 'x' }, STATIC_CACHE.warnings, GEOJSON),
          WarningsFile,
          STATIC_CACHE.warnings,
          GEOJSON,
        ).problems,
      ).toEqual(['not the contract document']);
      const f = {
        schemaVersion: 1,
        from: '2026-10-04T00:00:00Z',
        to: '2026-10-04T02:00:00Z',
        stepSeconds: 3600,
        series: [1],
        vlast: [[1, null]],
        attribution: [],
      };
      expect(readStatic(file(f, STATIC_CACHE.slow), FramesFile, STATIC_CACHE.slow).problems).toEqual([]);
      expect(
        readStatic(file({ ...f, vlast: [[1]] }, STATIC_CACHE.slow), FramesFile, STATIC_CACHE.slow).problems,
      ).toEqual(['not the contract document']);
    });
  });

  const metaDoc = (over: Record<string, unknown> = {}) =>
    ({
      now: '2026-10-04T12:34:56Z',
      displayStart: '2026-09-01T00:00:00Z',
      latestFrom: '2026-10-04T12:30:00Z',
      dayVersions: { '2026-09-20': 2 },
      sources: API_SOURCES.map((id) => ({ id, attribution: [] })),
      ...over,
    }) as never;

  it('static meta: the class, the sources and the day versions', () => {
    ok('static meta', checkStaticMeta(rd(metaDoc())));
    expect(checkStaticMeta(rd(metaDoc(), ['cache-control "x"']))).toMatchObject({ ok: false, detail: /cache-control/ });
    expect(checkStaticMeta(rd(metaDoc({ sources: [] })))).toMatchObject({ ok: false, detail: /NL-1 is not listed/ });
    expect(checkStaticMeta(rd(undefined, ['not the contract document']))).toMatchObject({ ok: false });
  });

  it('static latest: the seriesHash is the stations.json one', () => {
    const st = { seriesHash: 'aaaaaaaaaaaaaaaa', stations: [] } as never;
    ok('static latest', checkStaticLatest(rd({ seriesHash: 'aaaaaaaaaaaaaaaa', series: [1] } as never), st));
    expect(checkStaticLatest(rd({ seriesHash: 'bbbbbbbbbbbbbbbb', series: [] } as never), st)).toMatchObject({
      ok: false,
      detail: /not stations\.json's/,
    });
    expect(checkStaticLatest(rd({ seriesHash: 'aaaaaaaaaaaaaaaa', series: [] } as never), undefined)).toMatchObject({
      ok: false,
      detail: /no valid stations\.json/,
    });
  });

  it('static stations, sources, forecast: pass or surface the problems', () => {
    ok('static stations', checkStaticStations(rd({ stations: [] } as never)));
    expect(checkStaticStations(rd({ stations: [] } as never, ['content-type "x"']))).toMatchObject({ ok: false });
    ok('static sources', checkStaticSources(rd({ sources: [] } as never)));
    expect(checkStaticSources(rd({ sources: [] } as never, ['owner term BE-3']))).toMatchObject({
      ok: false,
      detail: /owner term BE-3/,
    });
    ok('static forecast', checkStaticForecast(rd({ runs: [] } as never)));
    expect(checkStaticForecast(rd(undefined, ['status 404']))).toMatchObject({ ok: false, detail: /status 404/ });
  });

  it('static recent: asks the current and the previous bucket, and checks t', () => {
    const c = recentCandidates('2026-10-04T12:34:56Z');
    expect(c.map((x) => x.path)).toEqual(['recent/2026-10-04/1230.json', 'recent/2026-10-04/1220.json']);
    expect(recentCandidates(undefined)).toEqual([]);
    const t = c[0]?.ms;
    ok('static recent', checkStaticRecent(rd({ t: '2026-10-04T12:30:00.000Z', series: [] } as never), t));
    expect(checkStaticRecent(rd({ t: '2026-10-04T12:20:00.000Z', series: [] } as never), t)).toMatchObject({
      ok: false,
      detail: /not the bucket asked/,
    });
    expect(checkStaticRecent(undefined, undefined)).toMatchObject({ ok: false });
  });

  describe('settled', () => {
    it('asks the newest settled day with its version, or none yet', () => {
      // now 2026-10-04T12:34Z, minus 72 h: 2026-10-01.
      expect(settledAsk(metaDoc(), 0)).toMatchObject({
        day: '2026-10-01',
        version: 1,
        t: Date.parse('2026-10-01T12:00:00Z'),
      });
      expect(settledAsk(metaDoc({ dayVersions: { '2026-10-01': 3 } }), 0)?.version).toBe(3);
      expect(settledAsk(metaDoc({ dayVersions: { '2026-10-01': 0 } }), 0)?.none).toMatch(/version 0/);
      expect(settledAsk(metaDoc({ displayStart: '2026-10-04T00:00:00Z' }), 0)?.none).toMatch(
        /before the display window/,
      );
      expect(settledAsk(metaDoc(), 2)?.none).toMatch(/pending/);
      expect(settledAsk(undefined, 0)).toBeUndefined();
    });
    it('passes a valid immutable file, a 404 with a reason, and fails an unexplained 404 or a wrong class', () => {
      const ask = settledAsk(metaDoc(), 0);
      expect(checkStaticSettled(ask, undefined)).toMatchObject({ ok: true, detail: /none yet/ });
      const none = settledAsk(metaDoc({ dayVersions: { '2026-10-01': 0 } }), 0);
      expect(checkStaticSettled(none, file('', '', 'text/plain', { status: 404 }))).toMatchObject({
        ok: true,
        detail: /none yet: day 2026-10-01 has version 0/,
      });
      expect(checkStaticSettled(ask, file('', '', 'text/plain', { status: 404 }))).toMatchObject({
        ok: false,
        detail: /status 404/,
      });
      expect(checkStaticSettled(undefined, undefined)).toMatchObject({ ok: false });
    });
  });

  it('static frames: recent, plus the settled day when it has a file', () => {
    const recent = rd({ series: [1] } as never);
    const ask = settledAsk(metaDoc(), 0);
    const bad = file({}, STATIC_CACHE.slow); // not immutable
    expect(checkStaticFrames(recent, ask, undefined)).toMatchObject({ ok: true, detail: /no settled day yet/ });
    expect(checkStaticFrames(recent, ask, bad)).toMatchObject({
      ok: false,
      detail: /frames\/2026-10-01\/v1\.json: cache-control/,
    });
    const none = settledAsk(metaDoc({ dayVersions: { '2026-10-01': 0 } }), 0);
    expect(checkStaticFrames(recent, none, file('', '', 'text/plain', { status: 404 }))).toMatchObject({
      ok: true,
      detail: /settled part: none yet/,
    });
    expect(checkStaticFrames(rd(undefined, ['status 404']), none, undefined)).toMatchObject({ ok: false });
  });

  it('static series: the station asked for is the station served', () => {
    ok('static series', checkStaticSeries(rd({ station: 'nl.rws.x', series: [] } as never), 'nl.rws.x'));
    expect(checkStaticSeries(rd({ station: 'nl.rws.y', series: [] } as never), 'nl.rws.x')).toMatchObject({
      ok: false,
      detail: /is not nl\.rws\.x/,
    });
    expect(checkStaticSeries(undefined, undefined)).toMatchObject({ ok: false });
  });

  it('static warnings: latest, and yesterday when it exists', () => {
    const latest = rd({ features: [] } as never);
    const day = '2026-10-03';
    const dated = {
      type: 'FeatureCollection',
      schemaVersion: 1,
      generatedAt: '2026-10-04T00:00:00Z',
      day,
      features: [],
      attribution: [],
    };
    ok('static warnings', checkStaticWarnings(latest, undefined));
    ok('static warnings', checkStaticWarnings(latest, { day, page: file('', '', 'text/plain', { status: 404 }) }));
    ok('static warnings', checkStaticWarnings(latest, { day, page: file(dated, STATIC_CACHE.immutable) }));
    expect(checkStaticWarnings(latest, { day, page: file(dated, STATIC_CACHE.warnings) })).toMatchObject({
      ok: false,
      detail: /2026-10-03: cache-control/,
    });
    expect(checkStaticWarnings(rd(undefined, ['content-type "application/json"']), undefined)).toMatchObject({
      ok: false,
    });
  });

  it('static status: the class, the contract and no owner source', () => {
    const doc = { sources: [{ id: 'DE-1' }], ownerSources: { healthy: 6, total: 6 } } as never;
    ok('static status', checkStaticStatus(rd(doc)));
    expect(
      checkStaticStatus(rd({ sources: [{ id: 'BE-3' }], ownerSources: { healthy: 0, total: 0 } } as never)),
    ).toMatchObject({ ok: false, detail: /owner source/ });
    expect(checkStaticStatus(rd(doc, ['cache-control "public, max-age=60"']))).toMatchObject({ ok: false });
  });

  describe('precompressed', () => {
    const body = Buffer.from('{"a":1}');
    const id = file(body.toString(), live, 'application/json', { bytes: body });
    const enc = (e: 'zstd' | 'gzip', bytes: Buffer, over: Record<string, string | undefined> = {}): Page => ({
      status: 200,
      headers: { 'content-encoding': e, vary: 'Accept-Encoding', ...over },
      body: '',
      bytes,
    });
    const good = { zstd: enc('zstd', zstdCompressSync(body)), gzip: enc('gzip', gzipSync(body)) };
    it('passes both encodings that decompress to the identity bytes', () => {
      ok('static precompressed', checkStaticPrecompressed(id, good));
    });
    it.each([
      [
        'no Content-Encoding',
        { ...good, gzip: enc('gzip', gzipSync(body), { 'content-encoding': undefined }) },
        /gzip: content-encoding null/,
      ],
      ['no Vary', { ...good, zstd: enc('zstd', zstdCompressSync(body), { vary: undefined }) }, /zstd: vary null/],
      [
        'a body that differs',
        { ...good, gzip: enc('gzip', gzipSync(Buffer.from('{"a":2}'))) },
        /gzip: the decompressed body differs/,
      ],
      [
        'a body that does not decompress',
        { ...good, zstd: enc('zstd', Buffer.from('nope')) },
        /zstd: the body does not decompress/,
      ],
      ['a failed request', { ...good, zstd: 'timeout' }, /zstd: timeout/],
    ])('fails %s', (_n, got, re) => {
      expect(checkStaticPrecompressed(id, got)).toMatchObject({ ok: false, detail: re });
    });
  });

  describe('lag and rerender', () => {
    const hl = (last_commit: string | null) => ({ loader: { last_commit } }) as never;
    it('lag: at most 120 s, none yet without a commit', () => {
      const m = metaDoc({ latestFrom: '2026-10-04T12:00:00Z' });
      expect(checkStaticLag(hl(null), m)).toMatchObject({ ok: true, detail: /none yet/ });
      ok('static lag', checkStaticLag(hl('2026-10-04T12:02:00Z'), m));
      expect(checkStaticLag(hl(`2026-10-04T12:0${Math.floor((STATIC_LAG_MAX_S + 1) / 60)}:01Z`), m)).toMatchObject({
        ok: false,
        detail: /121 s behind/,
      });
      ok('static lag', checkStaticLag(hl('2026-10-04T11:59:00Z'), m));
      expect(checkStaticLag(hl('2026-10-04T12:00:00Z'), metaDoc({ latestFrom: null }))).toMatchObject({
        ok: false,
        detail: /no latestFrom/,
      });
      expect(checkStaticLag(undefined, m)).toMatchObject({ ok: false });
    });
    it('rerender: under 60 s, none yet when null', () => {
      const st = (d: unknown) => rd({ publisher: { lastDayRender: d } } as never);
      expect(checkStaticRerender(st(null))).toMatchObject({ ok: true, detail: /none yet/ });
      ok(
        'static rerender',
        checkStaticRerender(st({ day: '2026-10-01', version: 1, seconds: RERENDER_MAX_S - 1, at: 'x' })),
      );
      expect(
        checkStaticRerender(st({ day: '2026-10-01', version: 1, seconds: RERENDER_MAX_S, at: 'x' })),
      ).toMatchObject({ ok: false, detail: /took 60 s/ });
      expect(checkStaticRerender(rd(undefined, ['status 404']))).toMatchObject({ ok: false });
    });
  });

  it('runtime config: exactly {"audience":"public"}, application/json, no-cache', () => {
    const rc = (body: string, over: Partial<Page> = {}) => file(body, 'no-cache', 'application/json', over);
    ok('runtime config', checkRuntimeConfig(rc('{"audience":"public"}')));
    expect(checkRuntimeConfig(rc('{"audience":"owner"}'))).toMatchObject({
      ok: false,
      detail: /not \{"audience":"public"\}/,
    });
    expect(checkRuntimeConfig(file('{"audience":"public"}', 'public, max-age=60'))).toMatchObject({
      ok: false,
      detail: /cache-control/,
    });
    expect(checkRuntimeConfig(file('{"audience":"public"}', 'no-cache', 'text/html'))).toMatchObject({
      ok: false,
      detail: /content-type/,
    });
    expect(checkRuntimeConfig(rc('', { status: 404 }))).toMatchObject({ ok: false, detail: /status 404/ });
    expect(checkRuntimeConfig('timeout')).toMatchObject({ ok: false });
  });

  it('the --dry-run list names each check once, and every name ci.yml requires is one of them', () => {
    const names = [
      'static meta',
      'static latest',
      'static stations',
      'static sources',
      'static recent',
      'static settled',
      'static frames',
      'static forecast',
      'static series',
      'static warnings',
      'static status',
      'static precompressed',
      'static lag',
      'static rerender',
      'runtime config',
    ];
    for (const n of names)
      expect(
        CHECKS.filter((c) => c.startsWith(`${n}:`)),
        n,
      ).toHaveLength(1);
    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const required = /for check in ([^;]*?); do/s.exec(ci.slice(ci.indexOf("'api meta'") - 20))?.[1] ?? '';
    for (const n of required
      .match(/'([^']+)'/g)
      ?.map((x) => x.slice(1, -1))
      .filter((x) => x.startsWith('static') || x === 'runtime config') ?? [])
      expect(names).toContain(n);
  });

  it('the owner-leak check also sees a public static body', () => {
    const terms = leakTerms(loadRegistry());
    expect(
      checkOwnerLeak({ '/data/v1/meta.json': '{"a":1}', '/data/v1/status.json': `{"x":"${OWNER_CANARY}"}` }, terms),
    ).toMatchObject({ ok: false, detail: /status\.json/ });
  });
});
