// Outside-in production check (issue #16 P1b build item 10; A§11.2 step 4;
// PHASES §2.1 [agent-prod]). No SSH: only what any visitor can fetch. Exits
// non-zero on any miss and prints one PASS/FAIL/N-A line per check.
//
//   scripts/verify-prod.sh <domain>              TLS (IPv4 and IPv6), the exact A§12.2
//                                                headers, noindex, /healthz, both status
//                                                files, per-spec freshness, owner_specs,
//                                                the P2a health API (contract, closed
//                                                parameters, DE-1 tier-1 freshness, loader
//                                                lag, replay), and no owner source, spec,
//                                                host, canary or private_basis in /status/*
//                                                or /api/v1/health*
//   scripts/verify-prod.sh <domain> --soak       + the 72 h soak: >= 99% per source, the
//                                                seed coverage, the byte baseline, the drill
//   scripts/verify-prod.sh <domain> --capacity [--owner-bytes-per-day N] [--out FILE]
//                                                docs/capacity.md from >= 2 complete days
//   scripts/verify-prod.sh <domain> --dry-run    list the checks; no network
// CI only (the end-to-end test against a local stack): --resolve <ip> --ca <pem file>

import { resolve4, resolve6 } from 'node:dns/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { loadRegistry, type Registry } from '../apps/server/src/capture/specs.ts';
import { CaptureStatus } from '../apps/server/src/capture/status.ts';
import { OpsStatus } from '../apps/server/src/watchdog/watchdog.ts';
import { Health, HealthSources, LAG_DEGRADED_S } from '../packages/contracts/src/index.ts';

const root = join(import.meta.dirname, '..');
export const CERT_MIN_DAYS = 14;
export const OWNER_CANARY = '777777.777';
/** The canaries as PostgreSQL prints them once stored as `real`, and the withheld canary (on NL-1; it appears nowhere). */
export const OWNER_CANARY_REAL = '777777.75';
export const WITHHELD_CANARY = '123456.789';
export const WITHHELD_CANARY_REAL = '123456.79';
/** The public API's only two routes (A§9.2 health). */
export const HEALTH_PATHS = ['/api/v1/health', '/api/v1/health/sources'] as const;
/** P2a criterion: at least this share of a source's tier-1 series is fresh. */
export const TIER1_MIN = 0.95;
/** The A§12.2 headers, compared byte for byte; values are read from ARCHITECTURE.md. */
export const HEADER_NAMES = [
  'Content-Security-Policy',
  'Strict-Transport-Security',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Permissions-Policy',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Resource-Policy',
] as const;
/** Seed coverage of the soak criterion (issue #16): days covered, or files for LU-5. */
export const SEED_MIN: Record<string, { days?: number; files?: number }> = {
  'de-1-series': { days: 28 },
  'fr-1-obs': { days: 28 },
  'ch-3-40d': { days: 38 },
  'de-7-pegeldaten': { days: 55 },
  'lu-5-cap': { files: 833 },
  'lu-1-csv': { days: 4 },
};
/** A§11.4: the database, basemap and static estimates that no capture measurement replaces. */
export const OTHER_GB = { database: 28, basemap: 9, static: 5 };
export const DISK_GB = 200;

export type Result = { check: string; ok: boolean | 'n/a'; detail: string };
const pass = (check: string, detail = ''): Result => ({ check, ok: true, detail });
const miss = (check: string, detail: string): Result => ({ check, ok: false, detail });

// ---------------------------------------------------------------- pure checks

/** The expected A§12.2 headers plus X-Robots-Tag: noindex (until the public launch, P12). */
export function expectedHeaders(architecture: string): Record<string, string> {
  const start = architecture.indexOf('- **HTTP headers** (Caddy):');
  const end = architecture.indexOf('- The owner site adds', start);
  if (start < 0 || end < 0) throw new Error('ARCHITECTURE.md: A§12.2 "HTTP headers" block not found');
  const block = architecture.slice(start, end);
  const out: Record<string, string> = {};
  for (const name of HEADER_NAMES) {
    const m = new RegExp(`\`${name}: ([^\`]+)\``).exec(block);
    if (m?.[1] === undefined) throw new Error(`ARCHITECTURE.md: A§12.2 lists no ${name}`);
    out[name.toLowerCase()] = m[1];
  }
  out['x-robots-tag'] = 'noindex';
  return out;
}

export function checkHeaders(
  path: string,
  status: number,
  headers: Readonly<Record<string, string | undefined>>,
  expected: Readonly<Record<string, string>>,
): Result {
  const problems: string[] = [];
  if (status !== 200) problems.push(`status ${status}`);
  for (const [name, value] of Object.entries(expected)) {
    if (headers[name] !== value) problems.push(`${name}: ${JSON.stringify(headers[name] ?? null)}`);
  }
  for (const name of Object.keys(headers)) {
    if (name.startsWith('access-control-')) problems.push(`CORS header ${name}`);
  }
  if (headers.server !== undefined) problems.push(`server: ${JSON.stringify(headers.server)}`);
  return problems.length === 0
    ? pass(`headers ${path}`, 'every A§12.2 header exact, noindex, no CORS, no Server')
    : miss(`headers ${path}`, problems.join('; '));
}

type StatusSpec = CaptureStatus['specs'][number];
/**
 * A spec with no success and no failure yet whose next run is scheduled and
 * not overdue by more than 3 × cadence_s: nothing to judge (after go-live, or
 * a new spec), as the contract's own freshness counts it from when it was
 * enabled. A spec with no next run (next_due null) is never scheduled, so stale.
 */
const notRunYet = (s: StatusSpec, now: Date) =>
  s.last_success === null &&
  s.last_failure_status === null &&
  s.next_due !== null &&
  now.getTime() - Date.parse(s.next_due) <= 3 * s.cadence_s * 1000;

/** Specs of capture.json without a success within 3 × cadence_s (a spec that has not run yet is not stale). */
export function staleSpecs(status: CaptureStatus, now: Date): string[] {
  return status.specs
    .filter((s) => !notRunYet(s, now))
    .filter((s) => s.last_success === null || now.getTime() - Date.parse(s.last_success) > 3 * s.cadence_s * 1000)
    .map((s) => s.spec);
}

/** IPv6 is n/a only when this machine has no IPv6 route; EHOSTUNREACH is the server's side, so a failure. */
export const noIpv6Here = (code: string) => code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL';

/** Everything that identifies owner-audience data: source IDs, spec IDs, hosts, the canary. */
export function ownerTerms(registry: Registry): string[] {
  const sources = [...registry.sources].filter(([, s]) => s.audience === 'owner').map(([id]) => id);
  const specs = registry.specs.filter((s) => s.audience === 'owner').map((s) => s.id);
  const hosts = sources.flatMap((id) => registry.hosts.get(id) ?? []);
  return [...new Set([...sources, ...specs, ...hosts, OWNER_CANARY])].sort();
}

export function leaks(body: string, terms: readonly string[]): string[] {
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return terms.filter((t) => new RegExp(`(?<![A-Za-z0-9.-])${esc(t)}(?![A-Za-z0-9-])`).test(body));
}

export function checkCapture(status: CaptureStatus, now: Date): Result[] {
  const stale = staleSpecs(status, now);
  const waiting = status.specs.filter((s) => notRunYet(s, now)).map((s) => s.spec);
  const owner = status.owner_specs;
  return [
    stale.length === 0
      ? pass('freshness', `${status.specs.length - waiting.length} public specs each succeeded within 3 × cadence_s`)
      : miss('freshness', `no success within 3 × cadence_s: ${stale.join(', ')}`),
    ...(waiting.length === 0
      ? []
      : [{ check: 'freshness not run yet', ok: 'n/a' as const, detail: `due later: ${waiting.join(', ')}` }]),
    owner !== undefined && owner.fresh === owner.total
      ? pass('owner_specs', `fresh ${owner.fresh} = total ${owner.total}`)
      : miss('owner_specs', owner === undefined ? 'missing' : `fresh ${owner.fresh} of ${owner.total}`),
  ];
}

/** The 72 h soak (issue #16): per source >= 99% ok, seed coverage, the byte baseline, the drill. */
export function soak(status: CaptureStatus, ops: OpsStatus): { results: Result[]; report: string[] } {
  const results: Result[] = [];
  const report: string[] = [
    '| Source | Scheduled | OK | Upstream 5xx | Timeouts | Other | OK % |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  const bySource = new Map<
    string,
    { scheduled: number; ok: number; upstream_5xx: number; timeouts: number; other: number }
  >();
  for (const d of status.days) {
    const t = bySource.get(d.source) ?? { scheduled: 0, ok: 0, upstream_5xx: 0, timeouts: 0, other: 0 };
    for (const k of ['scheduled', 'ok', 'upstream_5xx', 'timeouts', 'other'] as const) t[k] += d[k];
    bySource.set(d.source, t);
  }
  for (const [source, t] of [...bySource].sort()) {
    const pct = t.scheduled === 0 ? 100 : (100 * t.ok) / t.scheduled;
    report.push(
      `| ${source} | ${t.scheduled} | ${t.ok} | ${t.upstream_5xx} | ${t.timeouts} | ${t.other} | ${pct.toFixed(2)} |`,
    );
    results.push(
      pct >= 99
        ? pass(`soak ${source}`, `${pct.toFixed(2)}% of ${t.scheduled} (5xx ${t.upstream_5xx}, timeouts ${t.timeouts})`)
        : miss(
            `soak ${source}`,
            `${pct.toFixed(2)}% of ${t.scheduled} (5xx ${t.upstream_5xx}, timeouts ${t.timeouts}, other ${t.other})`,
          ),
    );
  }
  for (const [spec, min] of Object.entries(SEED_MIN)) {
    const seed = status.seeds.find((s) => s.spec === spec);
    const got = seed === undefined ? 'no seed record' : `${seed.days_covered} days, ${seed.files} files`;
    const ok =
      seed !== undefined &&
      (min.days === undefined || seed.days_covered >= min.days) &&
      (min.files === undefined || seed.files >= min.files);
    results.push(ok ? pass(`seed ${spec}`, got) : miss(`seed ${spec}`, `${got}; needs ${JSON.stringify(min)}`));
  }
  const drill = ops.drill;
  results.push(
    drill !== null && drill.sampled === 100 && drill.matched === 100
      ? pass('restore drill', `100 of 100 sha256 match (${drill.at})`)
      : miss('restore drill', drill === null ? 'no drill yet' : `${drill.matched} of ${drill.sampled} match`),
  );
  report.push('', '| Date | Spec | zstd bytes stored after dedup |', '|---|---|---:|');
  for (const d of status.days)
    for (const [spec, bytes] of Object.entries(d.bytes)) report.push(`| ${d.date} | ${spec} | ${bytes} |`);
  return { results, report };
}

const GB = 1e9;
/** docs/capacity.md from >= 2 complete UTC days of days[] (issue #16 criterion; gap item 16). */
export function capacity(
  status: CaptureStatus,
  registry: Registry,
  today: string,
  ownerBytesPerDay: number | null,
): { ok: boolean; markdown: string } {
  const complete = [...new Set(status.days.map((d) => d.date))].filter((d) => d < today).sort();
  if (complete.length < 2)
    return { ok: false, markdown: `only ${complete.length} complete UTC day(s) in days[]; need 2` };
  const perSpec = new Map<string, number>();
  for (const d of status.days) {
    if (!complete.includes(d.date)) continue;
    for (const [spec, bytes] of Object.entries(d.bytes)) perSpec.set(spec, (perSpec.get(spec) ?? 0) + bytes);
  }
  const rows: string[] = [];
  let disk = 0;
  let bucket = 0;
  for (const s of registry.specs.filter((x) => x.audience === 'public').sort((a, b) => a.id.localeCompare(b.id))) {
    const daily = (perSpec.get(s.id) ?? 0) / complete.length;
    const kept = s.retention === 'forever' ? 365 : 90;
    disk += daily * kept;
    bucket += daily * 365;
    rows.push(
      `| ${s.source} | ${s.id} | ${s.retention} | ${Math.round(daily)} | ${((daily * kept) / GB).toFixed(3)} |`,
    );
  }
  if (ownerBytesPerDay !== null) {
    disk += ownerBytesPerDay * 365;
    bucket += ownerBytesPerDay * 365;
    rows.push(
      `| owner (aggregate) | – | forever (upper bound) | ${Math.round(ownerBytesPerDay)} | ${((ownerBytesPerDay * 365) / GB).toFixed(3)} |`,
    );
  }
  const other = OTHER_GB.database + OTHER_GB.basemap + OTHER_GB.static;
  const total = disk / GB + other;
  const md = [
    '# Capacity (year 1)',
    '',
    `Measured from ${complete.length} complete UTC days of production capture (${complete[0]} to ${complete.at(-1)}), from the \`days[]\` block of \`/status/capture.json\`: zstd bytes stored after sha256 deduplication, per spec (\`scripts/verify-prod.sh --capacity\`, issue #16).`,
    ownerBytesPerDay === null
      ? 'Owner-audience specs are not in the public status file and are **not included**; add them with `--owner-bytes-per-day` (docs/runbooks/owner-checks.md).'
      : 'Owner-audience specs are included as one aggregate from the owner status file, counted as kept forever (an upper bound).',
    '',
    '## Per spec',
    '',
    '| Source | Spec | Retention | Bytes/day | Year-1 raw on disk (GB) |',
    '|---|---|---|---:|---:|',
    ...rows,
    '',
    '## Year-1 projection',
    '',
    '| Item | GB |',
    '|---|---:|',
    `| Raw archive on disk (obs: 90-day window; forever: 365 days) | ${(disk / GB).toFixed(1)} |`,
    `| Database (A§11.4 estimate, replaced in P2) | ${OTHER_GB.database} |`,
    `| Basemap, current and previous (A§11.4) | ${OTHER_GB.basemap} |`,
    `| Static files, images, logs (A§11.4) | ${OTHER_GB.static} |`,
    `| **Total on the ≥ ${DISK_GB} GB disk** | **${total.toFixed(1)}** (${((100 * total) / DISK_GB).toFixed(0)}%; the disk alert fires at 75%) |`,
    `| Off-site bucket: every raw object for 12 months (restic keeps 12 monthly snapshots) | ${(bucket / GB).toFixed(1)} |`,
    '',
  ].join('\n');
  return { ok: true, markdown: md };
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------- health API (P2a)

type Contract<T> = { safeParse(input: unknown): { success: true; data: T } | { success: false } };
type ApiRead<T> = { data?: T; problems: string[] };

/**
 * One answer of a health route: 200, JSON, `Cache-Control: max-age=30` and the
 * contract. `data` is set whenever the body is the contract document, whatever
 * else is wrong; a string is a network error.
 */
export function readApi<T>(page: Page | string, schema: Contract<T>): ApiRead<T> {
  if (typeof page === 'string') return { problems: [page] };
  const problems: string[] = [];
  if (page.status !== 200) problems.push(`status ${page.status}`);
  const type = page.headers['content-type'] ?? '';
  if (!/^application\/json(?:;|$)/.test(type)) problems.push(`content-type ${JSON.stringify(type)}`);
  const cache = page.headers['cache-control'] ?? '';
  if (!/(?:^|,\s*)max-age=30(?:\s*,|$)/.test(cache)) problems.push(`cache-control ${JSON.stringify(cache)}`);
  const parsed = schema.safeParse(parseJson(page.body));
  if (!parsed.success) problems.push('not the contract document');
  return parsed.success ? { data: parsed.data, problems } : { problems };
}

const noDocument = (check: string, what: string, r?: ApiRead<unknown>) =>
  miss(
    check,
    `no valid ${what} document${r === undefined || r.problems.length === 0 ? '' : `: ${r.problems.join('; ')}`}`,
  );

export function checkHealth(r: ApiRead<Health>): Result {
  const problems = [...r.problems];
  if (r.data?.status === 'down')
    problems.push(`status down (generated_at ${r.data.generated_at ?? 'never'}): the loader is not computing`);
  return r.data !== undefined && problems.length === 0
    ? pass('health', `200, the Health contract, max-age=30, status ${r.data.status}`)
    : miss('health', problems.join('; '));
}

/** What the api must answer for the routes it does not serve: 400 for a parameter, 404 for the rest of /api/. */
export const PARAM_CASES: readonly (readonly [string, number])[] = [
  ['/api/v1/health?x=1', 400],
  ['/api/v1/health/sources?x=1', 400],
  ['/api/v1/', 404],
  ['/api/v1/stations', 404],
];

export function checkHealthParams(got: Readonly<Record<string, Page | string>>): Result {
  const problems = PARAM_CASES.flatMap(([path, want]) => {
    const page = got[path];
    if (page === undefined || typeof page === 'string') return [`${path}: ${page ?? 'not asked'}`];
    const bad: string[] = [];
    if (page.status !== want) bad.push(`status ${page.status}, want ${want}`);
    else if (want === 400 && page.body !== '{"error":"unknown_parameter"}')
      bad.push('the body is not the fixed 400 body');
    return bad.map((b) => `${path}: ${b}`);
  });
  return problems.length === 0
    ? pass('health params', 'a query parameter is 400 on both health paths; /api/v1/ and /api/v1/stations are 404')
    : miss('health params', problems.join('; '));
}

const sourceOf = (doc: HealthSources | undefined, id: string) => doc?.sources.find((s) => s.id === id);

export function checkSourceHealth(r: ApiRead<HealthSources>, id = 'DE-1'): Result {
  const check = `health ${id}`;
  if (r.data === undefined || r.problems.length > 0) return noDocument(check, 'health/sources', r);
  const s = sourceOf(r.data, id);
  if (s === undefined) return miss(check, 'not listed in /api/v1/health/sources');
  return s.status === 'ok'
    ? pass(check, `status ok, last fetch ${s.last_fetch_ok ?? 'never'}`)
    : miss(
        check,
        `status ${s.status} (${s.consecutive_failures} failed fetches in a row, ${s.quarantined} quarantined)`,
      );
}

/**
 * P2a: >= 95% of the source's tier-1 series fresh. Series the provider itself
 * publishes nothing newer for (`provider_stale`, low water) are named, and
 * never turn a FAIL into a PASS: the owner judges the criterion then.
 */
export function checkTier1(doc: HealthSources | undefined, id = 'DE-1'): Result {
  const check = `tier-1 ${id}`;
  if (doc === undefined) return noDocument(check, 'health/sources');
  const t = sourceOf(doc, id)?.tier1;
  if (t === undefined || t === null || t.total === 0) return miss(check, 'no tier-1 numbers yet');
  const share = `${t.fresh} of ${t.total} tier-1 series fresh (${((100 * t.fresh) / t.total).toFixed(1)}%)`;
  if (t.fresh / t.total >= TIER1_MIN) return pass(check, share);
  const withStale = (t.fresh + t.provider_stale) / t.total >= TIER1_MIN;
  return miss(
    check,
    `${share}, below ${TIER1_MIN * 100}%; ${t.provider_stale} are provider-stale (the provider publishes nothing newer)` +
      (withStale ? `: with them ${t.fresh + t.provider_stale} of ${t.total}, for the owner to judge at low water` : ''),
  );
}

export function checkLoaderLag(doc: Health | undefined): Result {
  if (doc === undefined) return noDocument('loader lag', 'health');
  const lag = doc.loader.lag_p95_s;
  if (lag === null) return miss('loader lag', 'no lag sample yet (no fresh payload was loaded in the last hour)');
  return lag < LAG_DEGRADED_S
    ? pass('loader lag', `p95 ${lag.toFixed(1)} s < ${LAG_DEGRADED_S} s`)
    : miss('loader lag', `p95 ${lag.toFixed(1)} s, not under ${LAG_DEGRADED_S} s`);
}

/** The loader has caught up (no backlog), DE-1 has partition checksums and nothing of DE-1 is quarantined. */
export function checkReplay(health: Health | undefined, doc: HealthSources | undefined, id = 'DE-1'): Result {
  const check = `replay ${id}`;
  if (health === undefined) return noDocument(check, 'health');
  if (doc === undefined) return noDocument(check, 'health/sources');
  const s = sourceOf(doc, id);
  if (s === undefined) return miss(check, 'not listed in /api/v1/health/sources');
  const problems: string[] = [];
  if (health.loader.backlog_bytes > 0)
    problems.push(`loader backlog ${health.loader.backlog_bytes} bytes in ${health.loader.backlog_files} files`);
  if (s.partitions.length === 0) problems.push('no partition checksum');
  if (s.quarantined > 0) {
    const batches = doc.quarantined_batches
      .filter((b) => b.source === id)
      .map((b) => `${b.id} ${b.error ?? 'no code'}`);
    problems.push(
      `${s.quarantined} quarantined (newest: ${batches.length === 0 ? 'none listed' : batches.join(', ')})`,
    );
  }
  return problems.length === 0
    ? pass(
        check,
        `no backlog, ${s.partitions.length} partition checksums (${s.partitions.map((p) => p.partition).join(', ')}), none quarantined`,
      )
    : miss(check, problems.join('; '));
}

/** Every term that must not appear in a public body: owner sources, specs, hosts and both canaries in both renderings. */
export function leakTerms(registry: Registry): string[] {
  return [...new Set([...ownerTerms(registry), OWNER_CANARY_REAL, WITHHELD_CANARY, WITHHELD_CANARY_REAL])].sort();
}

/** The keys of a JSON document (at any depth) that name an owner-only field. */
export function ownerKeys(doc: unknown): string[] {
  if (Array.isArray(doc)) return doc.flatMap(ownerKeys);
  if (typeof doc !== 'object' || doc === null) return [];
  return Object.entries(doc).flatMap(([key, value]) => [
    ...(/private_basis/i.test(key) ? [key] : []),
    ...ownerKeys(value),
  ]);
}

/** No owner term and no owner-only key in any public body (`bodies`: label to text). */
export function checkOwnerLeak(bodies: Readonly<Record<string, string>>, terms: readonly string[]): Result {
  const found = Object.entries(bodies).flatMap(([label, body]) => {
    const hits = [...leaks(body, terms), ...ownerKeys(parseJson(body)).map((k) => `key ${k}`)];
    return hits.length === 0 ? [] : [`${label}: ${hits.join(', ')}`];
  });
  return found.length === 0
    ? pass(
        'owner leak',
        `none of ${terms.length} owner terms and no private_basis key in ${Object.keys(bodies).join(', ')}`,
      )
    : miss('owner leak', `found in ${found.join('; ')}`);
}

// ---------------------------------------------------------------- network

type Net = { resolve?: string; ca?: Buffer };
export type Page = { status: number; headers: Record<string, string | undefined>; body: string };

function lookupFor(net: Net): LookupFunction | undefined {
  if (net.resolve === undefined) return undefined;
  const address = net.resolve;
  const family = isIP(address);
  return ((_host: string, options: { all?: boolean }, cb: (...a: unknown[]) => void) =>
    options.all ? cb(null, [{ address, family }]) : cb(null, address, family)) as unknown as LookupFunction;
}

function get(url: string, net: Net): Promise<Page> {
  const u = new URL(url);
  const request = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      u,
      {
        method: 'GET',
        headers: { 'user-agent': 'rivierstanden-verify-prod' },
        timeout: 20_000,
        ...(net.ca === undefined ? {} : { ca: net.ca }),
        ...(lookupFor(net) === undefined ? {} : { lookup: lookupFor(net) }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 8 * 1024 * 1024) req.destroy(new Error('body too large'));
          else chunks.push(c);
        });
        res.on('end', () => {
          const headers: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** A page, or the error text when the request itself failed: the checks report it instead of crashing. */
const tryGet = (url: string, net: Net): Promise<Page | string> =>
  get(url, net).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));

/** TLS on one address: a certificate valid for the domain, days left. */
function tlsOn(domain: string, address: string, net: Net): Promise<{ days: number } | { error: string }> {
  return new Promise((resolve) => {
    const socket = tlsConnect({
      host: address,
      port: 443,
      servername: domain,
      ...(net.ca === undefined ? {} : { ca: net.ca }),
    });
    const done = (v: { days: number } | { error: string }) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(15_000, () => done({ error: 'timeout' }));
    socket.once('error', (e: NodeJS.ErrnoException) => done({ error: e.code ?? e.message }));
    socket.once('secureConnect', () => {
      const expires = Date.parse(socket.getPeerCertificate().valid_to);
      done({ days: Math.floor((expires - Date.now()) / 86_400_000) });
    });
  });
}

async function tlsChecks(domain: string, net: Net): Promise<Result[]> {
  const families: [string, () => Promise<string[]>][] =
    net.resolve !== undefined
      ? [[isIP(net.resolve) === 6 ? 'tls ipv6' : 'tls ipv4', async () => [net.resolve as string]]]
      : [
          ['tls ipv4', () => resolve4(domain)],
          ['tls ipv6', () => resolve6(domain)],
        ];
  const out: Result[] = [];
  for (const [check, resolveAll] of families) {
    const addrs = await resolveAll().catch(() => [] as string[]);
    if (addrs.length === 0) {
      out.push(check === 'tls ipv6' ? { check, ok: 'n/a', detail: 'no AAAA record' } : miss(check, 'no A record'));
      continue;
    }
    for (const address of addrs) {
      const r = await tlsOn(domain, address, net);
      if ('error' in r && check === 'tls ipv6' && noIpv6Here(r.error)) {
        out.push({ check: `${check} ${address}`, ok: 'n/a', detail: `no IPv6 route from here (${r.error})` });
      } else if ('error' in r) {
        out.push(miss(`${check} ${address}`, r.error));
      } else {
        out.push(
          r.days >= CERT_MIN_DAYS
            ? pass(`${check} ${address}`, `valid for ${domain}, ${r.days} days left`)
            : miss(`${check} ${address}`, `only ${r.days} days left`),
        );
      }
    }
  }
  return out;
}

async function statusFile(domain: string, name: string, net: Net): Promise<{ result: Result; page?: Page }> {
  const check = `status ${name}`;
  try {
    const page = await get(`https://${domain}/status/${name}`, net);
    if (page.status !== 200) return { result: miss(check, `status ${page.status}`) };
    if (page.headers['cache-control'] !== 'no-store')
      return { result: miss(check, `cache-control ${JSON.stringify(page.headers['cache-control'] ?? null)}`), page };
    return { result: pass(check, '200, Cache-Control: no-store'), page };
  } catch (e) {
    return { result: miss(check, (e as Error).message) };
  }
}

// ---------------------------------------------------------------- main

export const CHECKS = [
  'tls ipv4 / tls ipv6: a valid certificate for the domain on every A and AAAA address, >= 14 days left (IPv6 n/a without AAAA or route)',
  'headers / and /en/: 200 and every A§12.2 header byte for byte (CSP from ARCHITECTURE.md), X-Robots-Tag: noindex, no CORS, no Server',
  'healthz: GET /healthz answers 200',
  'http: http:// redirects to https://',
  'status capture.json / ops.json: 200, Cache-Control: no-store, the exact contract fields',
  'freshness: every public spec succeeded within 3 × cadence_s',
  'owner_specs: fresh = total',
  'health: GET /api/v1/health is 200 JSON with Cache-Control max-age=30, the Health contract document, status not down',
  'health params: ?x=1 on /api/v1/health and /api/v1/health/sources is 400 {"error":"unknown_parameter"}; /api/v1/ and /api/v1/stations are 404',
  'health DE-1: /api/v1/health/sources is the contract document and lists DE-1 with status ok',
  'tier-1 DE-1: >= 95% of the tier-1 series are fresh (provider-stale ones are named and never make it a PASS)',
  'loader lag: loader.lag_p95_s is not null and < 120 s',
  'replay DE-1: no loader backlog, a partition checksum for DE-1 and no quarantined DE-1 payload',
  'owner leak: no owner source ID, spec ID, host, canary (777777.777, 777777.75, 123456.789, 123456.79) or private_basis key in any /status/* or /api/v1/health* body',
  '--soak: >= 99% ok per source (5xx and timeouts listed), seed coverage, byte baseline, drill 100/100',
  '--capacity: bytes/day per spec over >= 2 complete days, the year-1 projection vs the disk and the bucket',
];

function usage(): never {
  console.error(
    'usage: scripts/verify-prod.sh <domain> [--soak | --capacity [--owner-bytes-per-day N] [--out FILE]] [--dry-run]',
  );
  process.exit(64);
}

async function main(argv: string[]): Promise<number> {
  const net: Net = {};
  let domain = '';
  let mode: 'default' | 'soak' | 'capacity' = 'default';
  let dry = false;
  let out: string | undefined;
  let ownerBytes: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i] ?? usage();
    if (a === '--soak') mode = 'soak';
    else if (a === '--capacity') mode = 'capacity';
    else if (a === '--dry-run') dry = true;
    else if (a === '--out') out = next();
    else if (a === '--owner-bytes-per-day') ownerBytes = Number(next());
    else if (a === '--resolve') net.resolve = next();
    else if (a === '--ca') net.ca = readFileSync(next());
    else if (a !== undefined && !a.startsWith('-') && domain === '') domain = a;
    else usage();
  }
  if (dry) {
    for (const c of CHECKS) console.log(c);
    return 0;
  }
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) usage();
  if (net.resolve !== undefined && isIP(net.resolve) === 0) usage();
  if (ownerBytes !== null && !(ownerBytes >= 0)) usage();

  const registry = loadRegistry();
  const now = new Date();
  const results: Result[] = [];
  const capture = await statusFile(domain, 'capture.json', net);
  const ops = await statusFile(domain, 'ops.json', net);
  results.push(capture.result, ops.result);
  const cap = capture.page && CaptureStatus.safeParse(parseJson(capture.page.body));
  const opsDoc = ops.page && OpsStatus.safeParse(parseJson(ops.page.body));
  if (cap === undefined || !cap.success) results.push(miss('capture.json contract', 'not the contract document'));
  if (opsDoc === undefined || !opsDoc.success) results.push(miss('ops.json contract', 'not the contract document'));

  if (mode === 'default') {
    results.push(...(await tlsChecks(domain, net)));
    const expected = expectedHeaders(readFileSync(join(root, 'docs/plan/ARCHITECTURE.md'), 'utf8'));
    for (const path of ['/', '/en/']) {
      try {
        const page = await get(`https://${domain}${path}`, net);
        results.push(checkHeaders(path, page.status, page.headers, expected));
      } catch (e) {
        results.push(miss(`headers ${path}`, (e as Error).message));
      }
    }
    try {
      const h = await get(`https://${domain}/healthz`, net);
      results.push(h.status === 200 ? pass('healthz', '200') : miss('healthz', `status ${h.status}`));
    } catch (e) {
      results.push(miss('healthz', (e as Error).message));
    }
    try {
      const r = await get(`http://${domain}/`, net);
      const loc = r.headers.location ?? '';
      results.push(
        [301, 302, 307, 308].includes(r.status) && loc.startsWith(`https://${domain}/`)
          ? pass('http', `${r.status} to https`)
          : miss('http', `status ${r.status}, location ${JSON.stringify(loc)}`),
      );
    } catch (e) {
      results.push(miss('http', (e as Error).message));
    }
    if (cap?.success) results.push(...checkCapture(cap.data, now));

    // The P2a health API (A§9.2). Every request has a fixed path; a network error is a FAIL, never a crash.
    const api = (path: string) => tryGet(`https://${domain}${path}`, net);
    const [healthPage, sourcesPage] = [await api(HEALTH_PATHS[0]), await api(HEALTH_PATHS[1])];
    const health = readApi(healthPage, Health);
    const sources = readApi(sourcesPage, HealthSources);
    const probes: Record<string, Page | string> = {};
    for (const [path] of PARAM_CASES) probes[path] = await api(path);
    results.push(
      checkHealth(health),
      checkHealthParams(probes),
      checkSourceHealth(sources),
      checkTier1(sources.data),
      checkLoaderLag(health.data),
      checkReplay(health.data, sources.data),
    );

    const body = (page: Page | string | undefined) => (typeof page === 'object' ? page.body : '');
    results.push(
      checkOwnerLeak(
        {
          '/status/*': `${capture.page?.body ?? ''}\n${ops.page?.body ?? ''}`,
          [HEALTH_PATHS[0]]: body(healthPage),
          [HEALTH_PATHS[1]]: body(sourcesPage),
        },
        leakTerms(registry),
      ),
    );
  } else if (mode === 'soak') {
    if (cap?.success && opsDoc?.success) {
      const s = soak(cap.data, opsDoc.data);
      results.push(...s.results);
      console.log(s.report.join('\n'));
    }
  } else if (cap?.success) {
    const c = capacity(cap.data, registry, now.toISOString().slice(0, 10), ownerBytes);
    if (out !== undefined && c.ok) writeFileSync(out, c.markdown);
    else console.log(c.markdown);
    results.push(c.ok ? pass('capacity', out ?? 'printed') : miss('capacity', c.markdown));
  }

  for (const r of results) {
    console.log(`${r.ok === 'n/a' ? 'N/A ' : r.ok ? 'PASS' : 'FAIL'} ${r.check}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => r.ok === false).length;
  console.log(`verify-prod: ${results.length} checks, ${failed} failed (${domain}, ${now.toISOString()})`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
