import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Counters } from '../apps/server/src/capture/runner.ts';
import { loadRegistry } from '../apps/server/src/capture/specs.ts';
import type { SpecState } from '../apps/server/src/capture/state.ts';
import { buildStatus, type CaptureStatus } from '../apps/server/src/capture/status.ts';
import type { OpsStatus } from '../apps/server/src/watchdog/watchdog.ts';
import {
  capacity,
  checkCapture,
  checkHeaders,
  expectedHeaders,
  leaks,
  noIpv6Here,
  OWNER_CANARY,
  ownerTerms,
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
  });
});
