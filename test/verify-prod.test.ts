import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Counters } from '../apps/server/src/capture/runner.ts';
import { loadRegistry } from '../apps/server/src/capture/specs.ts';
import type { SpecState } from '../apps/server/src/capture/state.ts';
import { buildStatus, type CaptureStatus } from '../apps/server/src/capture/status.ts';
import type { OpsStatus } from '../apps/server/src/watchdog/watchdog.ts';
import { Health, HealthSources } from '../packages/contracts/src/index.ts';
import {
  capacity,
  checkCapture,
  checkHeaders,
  checkHealth,
  checkHealthParams,
  checkLoaderLag,
  checkOwnerLeak,
  checkReplay,
  checkSourceHealth,
  checkTier1,
  expectedHeaders,
  leaks,
  leakTerms,
  noIpv6Here,
  OWNER_CANARY,
  ownerKeys,
  ownerTerms,
  PARAM_CASES,
  type Page,
  readApi,
  soak,
  staleSpecs,
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
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests; report-to csp",
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
    for (const name of ['health', 'health params', 'health DE-1', 'tier-1 DE-1', 'loader lag', 'replay DE-1'])
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
  partitions: [{ partition: '2026-10', md5: 'a'.repeat(32), rows: 9000 }],
  partitions_at: ago(60_000),
  ...over,
});
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
          },
        ],
      },
      /777777\.777/,
    ],
    [
      'the owner canary as real prints it',
      {
        twins: [
          { id: 'x', window_end: ago(1), n_aligned: 1, median_delta: 777777.75, max_delta: 1, lag_min: null, ok: true },
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
          },
        ],
      },
      /123456\.789/,
    ],
    [
      'the withheld canary as real prints it',
      {
        twins: [
          { id: 'x', window_end: ago(1), n_aligned: 1, median_delta: 123456.79, max_delta: 1, lag_min: null, ok: true },
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
