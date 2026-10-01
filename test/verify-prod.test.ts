import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Counters } from '../apps/server/src/capture/runner.ts';
import { loadRegistry } from '../apps/server/src/capture/specs.ts';
import type { SpecState } from '../apps/server/src/capture/state.ts';
import { buildStatus, type CaptureStatus } from '../apps/server/src/capture/status.ts';
import type { OpsStatus } from '../apps/server/src/watchdog/watchdog.ts';
import { basemapAssetsPath, Health, HealthSources, validateBasemap } from '../packages/contracts/src/index.ts';
import { TILE_FILE_RE, type TileFile, type TilesManifest } from '../packages/core/src/tiles-manifest.ts';
import {
  CHECKS,
  capacity,
  checkCapture,
  checkHeaders,
  checkHealth,
  checkHealthParams,
  checkLoaderLag,
  checkMapAsset,
  checkOwnerLeak,
  checkReplay,
  checkSourceHealth,
  checkTier1,
  checkTileFile,
  checkTiles404,
  checkTiles416,
  checkTilesManifestPage,
  checkTilesPrevious,
  checkTwin,
  expectedHeaders,
  leaks,
  leakTerms,
  MANIFEST_CACHE,
  MAP_ASSET_PATH,
  noIpv6Here,
  OWNER_CANARY,
  ownerKeys,
  ownerTerms,
  PARAM_CASES,
  type Page,
  PMTILES_MAGIC,
  readApi,
  readTilesManifest,
  soak,
  staleSpecs,
  TILE_416_REQUESTS,
  TILE_CACHE,
  TILE_HEADERS,
  TILES_404_PATHS,
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
      'tiles manifest',
      'tiles <file>',
      'tiles previous',
      'tiles 404',
      'map assets',
      'twin eijsden-grens-taw-nap',
    ])
      expect(r.stdout, name).toMatch(new RegExp(`^${name}:`, 'm'));
  });
});

// The P2a health checks (issue P2a [agent-prod] criteria): pure, on contract documents.

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const health = (over: Partial<Health> = {}): Health => ({
  status: 'ok',
  generated_at: ago(60_000),
  loader: { lag_p95_s: 34, backlog_files: 0, backlog_bytes: 0, backlog_age_s: null, bad_manifest_lines: 0 },
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

  it('health params: a parameter is the fixed 400 and the rest of /api/ is 404', () => {
    const good: Record<string, Page | string> = Object.fromEntries(
      PARAM_CASES.map(([path, status]) => [
        path,
        page(status === 400 ? '{"error":"unknown_parameter"}' : 'Not Found', { status }),
      ]),
    );
    expect(checkHealthParams(good)).toMatchObject({ check: 'health params', ok: true });
    const bad = checkHealthParams({
      ...good,
      '/api/v1/health?x=1': page('{"health":1}', { status: 200 }),
      '/api/v1/health/sources?x=1': page('{"error":"unknown_parameter","x":"1"}', { status: 400 }),
      '/api/v1/stations': page('[]', { status: 200 }),
      '/api/v1/': 'ECONNRESET',
    });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/health\?x=1: status 200, want 400/);
    expect(bad.detail).toMatch(/sources\?x=1: the body is not the fixed 400 body/);
    expect(bad.detail).toMatch(/\/api\/v1\/stations: status 200, want 404/);
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

// deploy/web/site.caddy: the routes of the tiles and the assets (P3). Validated against a real Caddy by
// hand (the offline run does not start one); the CI deploy job proves them end to end.

describe('site.caddy: the tile and asset routes', () => {
  const site = readFileSync(join(repoRoot, 'deploy/web/site.caddy'), 'utf8');
  /** A one-tab block `<opener> {` up to its closing one-tab brace, without the closing brace. */
  const block = (opener: string): string => {
    const start = site.indexOf(`\n\t${opener} {\n`);
    expect(start, opener).toBeGreaterThanOrEqual(0);
    return site.slice(start, site.indexOf('\n\t}\n', start + 1));
  };
  const lines = (s: string) => s.split('\n').map((l) => l.trim());
  const IMMUTABLE = `header Cache-Control "${TILE_CACHE}"`;
  /** The one request a tile file is served for (SR-1, SR2-1). */
  const ONE_RANGE =
    "{header.Range}.matches('^bytes=[0-9]+-[0-9]+$') && {header.If-Range} == '' && {header.If-Match} == '' && {header.If-Unmodified-Since} == ''";

  it('adds no second one-tab header block: the A§12.2 headers are the first and only one', () => {
    expect(site.match(/\n\theader \{\n/g)).toHaveLength(1);
    expect(site.toLowerCase()).not.toContain('access-control-');
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
    const at = (needle: string) => site.indexOf(needle);
    const order = [
      at('\thandle @tiles_manifest {'),
      at('\thandle @tiles_files {'),
      at('\thandle @tiles {'),
      at('\thandle @dotfiles {'),
      at('\thandle @assets {'),
      at('\thandle {\n\t\troot * /srv/www'),
    ];
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
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

  it('keeps encode off the tile files: one encode, scoped by a matcher that excludes /tiles/*', () => {
    expect(lines(block('@compressible'))).toEqual(['', '@compressible {', 'not path /tiles/*']);
    expect(site.match(/^\tencode .*$/gm)).toEqual(['\tencode @compressible zstd gzip']);
  });

  it('serves /assets/* immutable (A§9.1) for an existing file only, and the HTML pages with no Cache-Control', () => {
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
    // The catch-all that serves the HTML pages sets no header at all.
    expect(site).toMatch(/\n\thandle \{\n\t\troot \* \/srv\/www\n\t\tfile_server\n\t\}\n\}/);
  });

  it('has exactly the cache classes no-store, max-age=60 and immutable (tile files and assets), and no browse', () => {
    const cache = [...site.matchAll(/^\s+header Cache-Control "(.*)"$/gm)].map((m) => m[1]);
    expect(cache).toEqual(['no-store', 'no-store', MANIFEST_CACHE, TILE_CACHE, TILE_CACHE]);
    const directives = site.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(directives.join('\n')).not.toMatch(/\bbrowse\b/);
    // The file servers' roots: the status copy, the tiles and the site; never the parent /srv/rws.
    const roots = [...site.matchAll(/^\s+root \* (\S+)$/gm)].map((m) => m[1]);
    expect(new Set(roots)).toEqual(new Set(['/srv/rws/public/ops', '/srv/rws/tiles', '/srv/www']));
  });
});
