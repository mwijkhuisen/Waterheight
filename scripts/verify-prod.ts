// Outside-in production check (issue #16 P1b build item 10; A§11.2 step 4;
// PHASES §2.1 [agent-prod]). No SSH: only what any visitor can fetch. Exits
// non-zero on any miss and prints one PASS/FAIL/N-A line per check.
//
//   scripts/verify-prod.sh <domain>              TLS (IPv4 and IPv6), the exact A§12.2
//                                                headers, noindex, /healthz, both status
//                                                files, per-spec freshness, owner_specs,
//                                                the health API (contract, closed
//                                                parameters, DE-1 and NL-1 health, tier-1
//                                                freshness and replay, loader lag), the data
//                                                API through Caddy (P4b: /meta with the
//                                                release commit, /stations, three snapshots
//                                                at the server's own clock, /openapi.json,
//                                                the closed parameters, noindex on the app,
//                                                /api and /tiles, DE-1 and NL-1 data under
//                                                45 minutes old), the
//                                                basemap tiles (P3: the manifest, a Range
//                                                read of every listed file, the 404s, the
//                                                416 for no Range or two ranges) and
//                                                the pinned map assets, and no
//                                                owner source, spec, host, canary or
//                                                private_basis in /status/* or any /api/v1
//                                                body above
//   scripts/verify-prod.sh <domain> --soak       + the 72 h soak: >= 99% per source, the
//                                                seed coverage, the byte baseline, the drill,
//                                                the Eijsden-grens twin over 7 days
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
import {
  BACKLOG_MAX_AGE_S,
  CANARIES,
  CANARY_RENDERINGS,
  floorBucket,
  Health,
  HealthSources,
  LAG_DEGRADED_S,
  Meta,
  Snapshot,
  Stations,
} from '../packages/contracts/src/index.ts';
import {
  parseTilesManifest,
  type TileFile,
  type TilesManifest,
  TilesManifestError,
} from '../packages/core/src/tiles-manifest.ts';

const root = join(import.meta.dirname, '..');
export const CERT_MIN_DAYS = 14;
export const OWNER_CANARY = CANARIES.owner.text;
/** The two health routes of the public API (A§9.2). */
export const HEALTH_PATHS = ['/api/v1/health', '/api/v1/health/sources'] as const;
/** P2a criterion: at least this share of a source's tier-1 series is fresh. */
export const TIER1_MIN = 0.95;
/** The twin check runs hourly: 168 in 7 days. The soak allows a few missed hours (a deploy, a restart). */
export const TWIN_MIN_CHECKS_7D = 160;
/** The latest twin check is fresh when its hour ended no more than this long ago (one missed hour is allowed). */
export const TWIN_MAX_AGE_MS = 2 * 3_600_000;
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
 * One answer of an api route: 200, JSON, `Cache-Control` (`max-age=30`, the
 * health routes, or exactly `cache` when it is given) and the contract. `data`
 * is set whenever the body is the contract document, whatever else is wrong; a
 * string is a network error.
 */
export function readApi<T>(page: Page | string, schema: Contract<T>, cache?: string): ApiRead<T> {
  if (typeof page === 'string') return { problems: [page] };
  const problems: string[] = [];
  if (page.status !== 200) problems.push(`status ${page.status}`);
  const type = page.headers['content-type'] ?? '';
  if (!/^application\/json(?:;|$)/.test(type)) problems.push(`content-type ${JSON.stringify(type)}`);
  const sent = page.headers['cache-control'] ?? '';
  if (cache === undefined ? !/(?:^|,\s*)max-age=30(?:\s*,|$)/.test(sent) : sent !== cache)
    problems.push(`cache-control ${JSON.stringify(sent)}`);
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

/** What the api must answer through Caddy (P4b): 400 for a parameter, its own JSON 404 for a path it does not serve. */
export const PARAM_CASES: readonly (readonly [string, number])[] = [
  ['/api/v1/health?x=1', 400],
  ['/api/v1/health/sources?x=1', 400],
  ['/api/v1/', 404],
  ['/api/v1/x', 404],
];
/** The fixed body of each refusal (`{"error": <code>}`, nothing of the request echoed). */
const REFUSAL_BODY: Readonly<Record<number, string>> = {
  400: '{"error":"unknown_parameter"}',
  404: '{"error":"not_found"}',
};

export function checkHealthParams(got: Readonly<Record<string, Page | string>>): Result {
  const problems = PARAM_CASES.flatMap(([path, want]) => {
    const page = got[path];
    if (page === undefined || typeof page === 'string') return [`${path}: ${page ?? 'not asked'}`];
    const bad: string[] = [];
    if (page.status !== want) bad.push(`status ${page.status}, want ${want}`);
    else if (page.body !== REFUSAL_BODY[want]) bad.push(`the body is not the fixed ${want} body`);
    return bad.map((b) => `${path}: ${b}`);
  });
  return problems.length === 0
    ? pass(
        'health params',
        "a query parameter is 400 on both health paths; /api/v1/ and /api/v1/x are the api's JSON 404",
      )
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
 * P2a, P2b: >= 95% of the source's tier-1 series fresh (each series against the limit the registry declares for
 * it, counted by the loader). Series the provider itself
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

/** The loader keeps up: a fresh lag sample under 2 minutes, and no manifest line waiting 15 minutes or more (a stall). */
export function checkLoaderLag(doc: Health | undefined): Result {
  if (doc === undefined) return noDocument('loader lag', 'health');
  const lag = doc.loader.lag_p95_s;
  const age = doc.loader.backlog_age_s;
  const problems: string[] = [];
  if (lag === null) problems.push('no lag sample yet (no fresh payload was loaded in the last hour)');
  else if (lag >= LAG_DEGRADED_S) problems.push(`p95 ${lag.toFixed(1)} s, not under ${LAG_DEGRADED_S} s`);
  if (age !== null && age >= BACKLOG_MAX_AGE_S)
    problems.push(
      `stalled: the oldest unconsumed manifest line is ${Math.round(age)} s old (limit ${BACKLOG_MAX_AGE_S} s)`,
    );
  return problems.length === 0 && lag !== null
    ? pass('loader lag', `p95 ${lag.toFixed(1)} s < ${LAG_DEGRADED_S} s, oldest unconsumed line ${age ?? 0} s old`)
    : miss('loader lag', problems.join('; '));
}

/** The loader has caught up (no backlog), the source has partition checksums and nothing of it is quarantined. */
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

/**
 * The soak criterion of a twin pair (P2b): its latest hourly check is fresh, has aligned timestamps and is ok, and
 * none of the last 7 days' hourly checks failed. Only counts and our own identifiers are printed.
 */
export function checkTwin(r: ApiRead<HealthSources>, now: Date, id = 'eijsden-grens-taw-nap'): Result {
  const check = `twin ${id}`;
  if (r.data === undefined || r.problems.length > 0) return noDocument(check, 'health/sources', r);
  const t = r.data.twins.find((x) => x.id === id);
  if (t === undefined) return miss(check, 'not listed in /api/v1/health/sources');
  const problems: string[] = [];
  const age = now.getTime() - Date.parse(t.window_end);
  if (age > TWIN_MAX_AGE_MS)
    problems.push(`latest check is ${Math.ceil(age / 60_000)} min old (limit ${TWIN_MAX_AGE_MS / 60_000} min)`);
  if (t.n_aligned === 0) problems.push('no aligned timestamps');
  if (!t.ok) problems.push('the latest check is outside the tolerance');
  if (t.failed_7d > 0) problems.push(`${t.failed_7d} of ${t.checks_7d} checks failed in 7 days`);
  if (t.checks_7d < TWIN_MIN_CHECKS_7D)
    problems.push(`only ${t.checks_7d} checks in 7 days: the soak needs ${TWIN_MIN_CHECKS_7D}`);
  return problems.length === 0
    ? pass(check, `${t.n_aligned} aligned timestamps in the latest check, ${t.checks_7d} checks in 7 days, none failed`)
    : miss(check, problems.join('; '));
}

/** Every term that must not appear in a public body: owner sources, specs, hosts and both canaries in both renderings. */
export function leakTerms(registry: Registry): string[] {
  return [...new Set([...ownerTerms(registry), ...CANARY_RENDERINGS])].sort();
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

// ---------------------------------------------------------------- basemap tiles (P3)

/** A§9.1: a dated tile file, and the pinned map assets, never change. */
export const TILE_CACHE = 'public, max-age=31536000, immutable';
/** The manifest changes on every promote: a short TTL, never immutable. */
export const MANIFEST_CACHE = 'public, max-age=60';
/** The PMTiles v3 header starts with "PMTiles" and the version byte 3. */
export const PMTILES_MAGIC = 'PMTiles\u0003';
/** A tile file is read like the client reads it: a Range, and the encodings a browser offers (Caddy must apply none). */
export const TILE_HEADERS = { range: 'bytes=0-15', 'accept-encoding': 'gzip, zstd' } as const;
/** A glyph range of the pinned assets: `/assets/map/<first 7 of assets.commit in registry/basemap.yaml>/`. */
export const MAP_ASSET_PATH = '/assets/map/028c18f/fonts/Noto%20Sans%20Regular/0-255.pbf';
/** Paths under /tiles that answer 404: the directory, the staging directory, a dated name nothing promoted. */
export const TILES_404_PATHS = ['/tiles/', '/tiles/.staging/', '/tiles/basemap-19700101.pmtiles'] as const;
/**
 * Requests for the current basemap file that Caddy refuses with 416: only one explicit
 * range is served (SR-1). A range-less GET that is not refused streams the file; `get` cuts it off at 8 MiB.
 */
export const TILE_416_REQUESTS = [
  ['no Range', {}],
  ['two ranges', { range: 'bytes=0-0,2-2' }],
] as const;

const show = (v: string | undefined) => JSON.stringify(v ?? null);

export type ManifestRead = { manifest?: TilesManifest; problems: string[] };

/**
 * `/tiles/manifest.json`: 200, `Cache-Control` exactly max-age=60 and a body
 * `parseTilesManifest` accepts. `manifest` is set whenever the body is a valid
 * manifest, whatever else is wrong; a string is a network error.
 */
export function readTilesManifest(page: Page | string): ManifestRead {
  if (typeof page === 'string') return { problems: [page] };
  const problems: string[] = [];
  if (page.status !== 200) problems.push(`status ${page.status}`);
  const cache = page.headers['cache-control'];
  if (cache !== MANIFEST_CACHE) problems.push(`cache-control ${show(cache)}`);
  try {
    return { manifest: parseTilesManifest(page.body), problems };
  } catch (e) {
    // A fixed code and a fixed schema path, never content of the body.
    problems.push(e instanceof TilesManifestError ? e.message : 'not the manifest');
    return { problems };
  }
}

export function checkTilesManifestPage(r: ManifestRead): Result {
  const m = r.manifest;
  return m !== undefined && r.problems.length === 0
    ? pass(
        'tiles manifest',
        `200, ${MANIFEST_CACHE}, current build ${m.current.build} (tiles ${m.current.version}), previous ${m.previous?.build ?? 'none'}`,
      )
    : miss('tiles manifest', r.problems.join('; '));
}

/** Every file the manifest lists, current first, then the previous extract's. */
export const tileFiles = (m: TilesManifest | undefined): TileFile[] =>
  m === undefined
    ? []
    : [m.current, ...(m.previous === null ? [] : [m.previous])].flatMap((e) => [e.basemap, e.planet]);

/**
 * One listed file, read with `TILE_HEADERS`: 206, `Content-Range` with the
 * manifest's byte count as the total, immutable, no `Content-Encoding`, and the
 * PMTiles v3 magic first. Only fixed strings and the validated file name are printed.
 */
export function checkTileFile(file: TileFile, page: Page | string): Result {
  const check = `tiles ${file.file}`;
  if (typeof page === 'string') return miss(check, page);
  const problems: string[] = [];
  if (page.status !== 206) problems.push(`status ${page.status}, want 206`);
  const range = page.headers['content-range'];
  if (range !== `bytes 0-15/${file.bytes}`)
    problems.push(`content-range ${show(range)}, want bytes 0-15/${file.bytes}`);
  const cache = page.headers['cache-control'];
  if (cache !== TILE_CACHE) problems.push(`cache-control ${show(cache)}`);
  const encoding = page.headers['content-encoding'];
  if (encoding !== undefined) problems.push(`content-encoding ${show(encoding)}`);
  if (!page.body.startsWith(PMTILES_MAGIC)) problems.push('not a PMTiles v3 file');
  return problems.length === 0
    ? pass(check, `206, bytes 0-15/${file.bytes}, immutable, no Content-Encoding, PMTiles v3`)
    : miss(check, problems.join('; '));
}

/** n/a while the manifest has no previous extract (the first run); a pass once it lists one. */
export function checkTilesPrevious(r: ManifestRead): Result {
  const check = 'tiles previous';
  if (r.manifest === undefined) return miss(check, 'no valid manifest');
  const p = r.manifest.previous;
  return p === null
    ? { check, ok: 'n/a', detail: 'one extract so far; run the job again on a later build' }
    : pass(check, `build ${p.build} (tiles ${p.version}) is listed; its two files are read above`);
}

/** Everything else under /tiles is a 404, and no 404 is marked immutable (a browser would keep it for a year). */
export function checkTiles404(got: Readonly<Record<string, Page | string>>): Result {
  const problems = TILES_404_PATHS.flatMap((path) => {
    const page = got[path];
    if (page === undefined || typeof page === 'string') return [`${path}: ${page ?? 'not asked'}`];
    const bad: string[] = [];
    if (page.status !== 404) bad.push(`status ${page.status}, want 404`);
    if (/immutable/i.test(page.headers['cache-control'] ?? '')) bad.push('a 404 marked immutable');
    return bad.map((b) => `${path}: ${b}`);
  });
  return problems.length === 0
    ? pass('tiles 404', `${TILES_404_PATHS.join(', ')} are 404 and not immutable`)
    : miss('tiles 404', problems.join('; '));
}

/** The current basemap file without a Range and with two ranges: 416, and never marked immutable. */
export function checkTiles416(file: TileFile | undefined, got: Readonly<Record<string, Page | string>>): Result {
  const check = 'tiles 416';
  if (file === undefined) return miss(check, 'no valid manifest');
  const problems = TILE_416_REQUESTS.flatMap(([label]) => {
    const page = got[label];
    if (page === undefined || typeof page === 'string') return [`${label}: ${page ?? 'not asked'}`];
    const bad: string[] = [];
    if (page.status !== 416) bad.push(`status ${page.status}, want 416`);
    if (/immutable/i.test(page.headers['cache-control'] ?? '')) bad.push('marked immutable');
    return bad.map((b) => `${label}: ${b}`);
  });
  return problems.length === 0
    ? pass(check, `${file.file}: no Range and two ranges are 416, not immutable`)
    : miss(check, problems.join('; '));
}

/** A glyph file of the pinned map assets: 200, non-empty, immutable. */
export function checkMapAsset(page: Page | string): Result {
  const check = 'map assets';
  if (typeof page === 'string') return miss(check, page);
  const problems: string[] = [];
  if (page.status !== 200) problems.push(`status ${page.status}, want 200`);
  const cache = page.headers['cache-control'];
  if (cache !== TILE_CACHE) problems.push(`cache-control ${show(cache)}`);
  if (page.status === 200 && page.body.length === 0) problems.push('empty body');
  return problems.length === 0 ? pass(check, `${MAP_ASSET_PATH}: 200, immutable`) : miss(check, problems.join('; '));
}

// ---------------------------------------------------------------- data API (P4b)

/** Cache-Control of the fixed data routes (A§9.2), compared exactly. */
export const META_CACHE = 'public, max-age=60';
export const STATIONS_CACHE = 'public, max-age=300';
export const OPENAPI_CACHE = 'public, max-age=300';
/** The public sources that /meta and /stations must show (the two with a loader since P2). */
export const API_SOURCES = ['NL-1', 'DE-1'] as const;
/** A source is fresh when one of its series has a value in the current snapshot no older than this at meta.now (45 min). */
export const FRESH_MAX_AGE_S = 2700;
/** A§12.2: also the apps, the api and the tiles say noindex until the public launch (P12), whatever the status. */
export const NOINDEX_PATHS = ['/', '/en/', '/api', '/tiles'] as const;
/**
 * The three snapshots, by how far before the server's "now" they sit, with the Cache-Control A§9.2 gives
 * their age: the current bucket, under 48 hours, older.
 */
export const SNAPSHOT_ASKS = [
  { name: 'now', back: 0, cache: 'public, max-age=60, stale-while-revalidate=300' },
  { name: '6h', back: 6 * 3_600_000, cache: 'public, max-age=600' },
  { name: '3d', back: 3 * 86_400_000, cache: 'public, max-age=86400' },
] as const;
export type SnapshotAsk = (typeof SNAPSHOT_ASKS)[number];

/** /openapi.json: an OpenAPI 3.1.0 document (its shape is the contracts package's own test). */
export const OpenApi31: Contract<{ openapi: '3.1.0' }> = {
  safeParse: (input) =>
    typeof input === 'object' && input !== null && 'openapi' in input && input.openapi === '3.1.0'
      ? { success: true, data: { openapi: '3.1.0' } }
      : { success: false },
};

const seriesOf = (doc: Stations | undefined, source: string) =>
  doc?.stations.flatMap((st) => st.series.filter((s) => s.source === source)) ?? [];

/** 200, `Cache-Control` exactly max-age=60, the Meta contract, and NL-1 and DE-1 among the sources. */
export function checkMeta(r: ApiRead<Meta>): Result {
  const problems = [...r.problems];
  const listed = r.data?.sources.map((s) => s.id) ?? [];
  if (r.data !== undefined)
    for (const id of API_SOURCES) if (!listed.includes(id)) problems.push(`${id} is not listed in sources`);
  return r.data !== undefined && problems.length === 0
    ? pass('api meta', `200, ${META_CACHE}, the Meta contract, sources ${listed.join(', ')}`)
    : miss('api meta', problems.join('; '));
}

/** KG-109: the image of a release reports the release's commit; `dev` is an image built any other way. */
export function checkBuild(meta: Meta | undefined): Result {
  const check = 'api build';
  if (meta === undefined) return noDocument(check, 'meta');
  return /^[0-9a-f]{40}$/.test(meta.build)
    ? pass(check, `build ${meta.build}`)
    : miss(check, `build is "${meta.build}": the image carries no RWS_BUILD (KG-109)`);
}

/** 200, `Cache-Control` exactly max-age=300, the Stations contract, a DE-1 and an NL-1 series. */
export function checkStations(r: ApiRead<Stations>): Result {
  const problems = [...r.problems];
  if (r.data !== undefined)
    for (const id of API_SOURCES) if (seriesOf(r.data, id).length === 0) problems.push(`no station has a ${id} series`);
  return r.data !== undefined && problems.length === 0
    ? pass(
        'api stations',
        `200, ${STATIONS_CACHE}, the Stations contract, ${r.data.stations.length} stations, ${API_SOURCES.map((id) => `${seriesOf(r.data, id).length} ${id}`).join(' and ')} series`,
      )
    : miss('api stations', problems.join('; '));
}

/**
 * The instant `back` before the server's own `now` (`/api/v1/meta`, never this machine's clock: a skewed
 * verifier would get a 400), floored to the 10-minute UTC grid, and the request that asks for it
 * (`YYYY-MM-DDTHH:MMZ`: nothing to escape).
 */
export function snapshotAt(serverNow: string | undefined, back: number): { ms: number; path: string } | undefined {
  const now = Date.parse(serverNow ?? '');
  if (Number.isNaN(now)) return undefined;
  const ms = floorBucket(now - back);
  return { ms, path: `/api/v1/snapshot?t=${new Date(ms).toISOString().slice(0, 16)}Z` };
}

/** One snapshot: 200, the Snapshot contract, `t` the instant asked for and the Cache-Control of its age. */
export function readSnapshot(ask: SnapshotAsk, ms: number, page: Page | string): ApiRead<Snapshot> {
  // The api picks the policy on its own clock when the request arrives. When that has moved into the next
  // bucket since /meta was answered (the Date header shows it), "now" is already a past instant.
  const served = typeof page === 'string' ? Number.NaN : Date.parse(page.headers.date ?? '');
  const cache = ask.name === 'now' && floorBucket(served) > ms ? SNAPSHOT_ASKS[1].cache : ask.cache;
  const r = readApi(page, Snapshot, cache);
  return r.data !== undefined && Date.parse(r.data.t) !== ms
    ? { ...r, problems: [...r.problems, 't is not the instant asked for'] }
    : r;
}

/** `r` is undefined when /meta gave no server time to ask for. */
export function checkSnapshot(ask: SnapshotAsk, r: ApiRead<Snapshot> | undefined): Result {
  const check = `api snapshot ${ask.name}`;
  if (r === undefined) return miss(check, 'no server time from /api/v1/meta');
  return r.data !== undefined && r.problems.length === 0
    ? pass(
        check,
        `200, the Snapshot contract, t ${r.data.t}, ${r.data.values.length} values, Cache-Control for its age`,
      )
    : miss(check, r.problems.join('; '));
}

export function checkOpenapi(r: ApiRead<{ openapi: '3.1.0' }>): Result {
  return r.data !== undefined && r.problems.length === 0
    ? pass('api openapi', `200, ${OPENAPI_CACHE}, openapi 3.1.0`)
    : miss('api openapi', r.problems.join('; '));
}

/** An unknown query parameter on /api/v1/meta: 400, the fixed body, `no-store`. */
export function checkApiParams(page: Page | string): Result {
  const check = 'api params';
  if (typeof page === 'string') return miss(check, page);
  const problems: string[] = [];
  if (page.status !== 400) problems.push(`status ${page.status}, want 400`);
  else if (page.body !== REFUSAL_BODY[400]) problems.push('the body is not the fixed 400 body');
  if (page.headers['cache-control'] !== 'no-store')
    problems.push(`cache-control ${show(page.headers['cache-control'])}`);
  return problems.length === 0 ? pass(check, '400, the fixed body, no-store') : miss(check, problems.join('; '));
}

/** Every path answers with `X-Robots-Tag: noindex`, a 404 of Caddy's (`/api`, `/tiles`) as much as the pages. */
export function checkNoindex(got: Readonly<Record<string, Page | string>>): Result {
  const lacking = NOINDEX_PATHS.flatMap((path) => {
    const page = got[path];
    if (page === undefined || typeof page === 'string') return [`${path}: ${page ?? 'not asked'}`];
    const tag = page.headers['x-robots-tag'];
    return tag === 'noindex' ? [] : [`${path}: x-robots-tag ${show(tag)}`];
  });
  return lacking.length === 0
    ? pass('noindex', `X-Robots-Tag: noindex on ${NOINDEX_PATHS.join(', ')}, whatever the status`)
    : miss('noindex', lacking.join('; '));
}

/**
 * At least one series of the source has a value in the snapshot no older than 45 minutes at the server's own
 * now (`meta.now`): the snapshot's `ageSeconds` counts from its `t`, which is floored to 10 minutes.
 */
export function checkFresh(
  source: string,
  snapshot: Snapshot | undefined,
  stations: Stations | undefined,
  now: string | undefined,
): Result {
  const check = `fresh ${source}`;
  if (snapshot === undefined || stations === undefined || now === undefined)
    return noDocument(check, snapshot === undefined ? 'snapshot' : stations === undefined ? 'stations' : 'meta');
  const listed = new Set(seriesOf(stations, source).map((s) => s.id));
  const nowMs = Date.parse(now);
  const ages = snapshot.values
    .filter((v) => listed.has(v.series))
    .map((v) => Math.round((nowMs - Date.parse(v.ts)) / 1000));
  if (ages.length === 0) return miss(check, `none of the ${listed.size} ${source} series has a value`);
  const newest = ages.reduce((a, b) => Math.min(a, b));
  const detail = `${ages.length} of ${listed.size} ${source} series have a value, the newest is ${newest} s old`;
  return newest <= FRESH_MAX_AGE_S ? pass(check, detail) : miss(check, `${detail}, over ${FRESH_MAX_AGE_S} s`);
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

function get(url: string, net: Net, headers: Readonly<Record<string, string>> = {}): Promise<Page> {
  const u = new URL(url);
  const request = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      u,
      {
        method: 'GET',
        headers: { 'user-agent': 'rivierstanden-verify-prod', ...headers },
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
const tryGet = (url: string, net: Net, headers?: Readonly<Record<string, string>>): Promise<Page | string> =>
  get(url, net, headers).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));

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
  'health params: ?x=1 on /api/v1/health and /api/v1/health/sources is 400 {"error":"unknown_parameter"}; /api/v1/ and /api/v1/x are the api\'s 404 {"error":"not_found"}',
  'health DE-1: /api/v1/health/sources is the contract document and lists DE-1 with status ok',
  'tier-1 DE-1: >= 95% of the tier-1 series are fresh (provider-stale ones are named and never make it a PASS)',
  `loader lag: loader.lag_p95_s is not null and < ${LAG_DEGRADED_S} s, and loader.backlog_age_s < ${BACKLOG_MAX_AGE_S} s (a stall fails it)`,
  'replay DE-1: no loader backlog, a partition checksum for DE-1 and no quarantined DE-1 payload',
  'health NL-1: /api/v1/health/sources lists NL-1 with status ok',
  'tier-1 NL-1: >= 95% of the tier-1 series are fresh, each against its own limit (provider-stale ones are named and never make it a PASS)',
  'replay NL-1: no loader backlog, a partition checksum for NL-1 and no quarantined NL-1 payload',
  `api meta: GET /api/v1/meta is 200 with Cache-Control exactly "${META_CACHE}", the Meta contract document, and NL-1 and DE-1 among the sources`,
  'api build: /api/v1/meta build is the 40-hex release commit, not "dev" (KG-109: the image carries RWS_BUILD)',
  `api stations: GET /api/v1/stations is 200 with Cache-Control exactly "${STATIONS_CACHE}", the Stations contract document, a station with a DE-1 series and one with an NL-1 series`,
  ...SNAPSHOT_ASKS.map(
    (a) =>
      `api snapshot ${a.name}: GET /api/v1/snapshot?t= at the 10-minute floor of the server's own now${a.back === 0 ? '' : ` - ${a.name}`} (from /meta, never this clock) is 200, the Snapshot contract with t as asked, Cache-Control exactly "${a.cache}"`,
  ),
  `api openapi: GET /api/v1/openapi.json is 200 with Cache-Control exactly "${OPENAPI_CACHE}" and openapi 3.1.0`,
  'api params: GET /api/v1/meta?x=1 is 400 {"error":"unknown_parameter"} with Cache-Control: no-store',
  `noindex: ${NOINDEX_PATHS.join(', ')} each answer (the 404s of /api and /tiles too) with X-Robots-Tag: noindex`,
  ...['DE-1', 'NL-1'].map(
    (id) =>
      `fresh ${id}: in the "now" snapshot at least one ${id} series has a value no older than ${FRESH_MAX_AGE_S} s at the server's own now (/meta)`,
  ),
  `tiles manifest: GET /tiles/manifest.json is 200 with Cache-Control exactly "${MANIFEST_CACHE}" (never immutable) and a body parseTilesManifest accepts`,
  `tiles <file>: every file the manifest lists (current and previous), GET with Range: ${TILE_HEADERS.range} and Accept-Encoding: ${TILE_HEADERS['accept-encoding']}, is 206 with Content-Range bytes 0-15/<manifest bytes>, Cache-Control exactly "${TILE_CACHE}", no Content-Encoding and the PMTiles v3 magic first`,
  'tiles previous: n/a while the manifest has no previous extract (run the job again on a later build); a pass once it lists one',
  `tiles 404: ${TILES_404_PATHS.join(', ')} are 404 and none is marked immutable`,
  `tiles 416: GET on the current basemap file without Range, and with Range: ${TILE_416_REQUESTS[1][1].range}, is 416 and not immutable (only one explicit range is served)`,
  `map assets: GET ${MAP_ASSET_PATH} (a pinned glyph range of the web image) is 200 with Cache-Control exactly "${TILE_CACHE}"`,
  `owner leak: no owner source ID, spec ID, host, canary (${CANARY_RENDERINGS.join(', ')}) or private_basis key in any /status/* body or /api/v1/health, health/sources, meta, stations and snapshot body`,
  '--soak: >= 99% ok per source (5xx and timeouts listed), seed coverage, byte baseline, drill 100/100',
  `twin eijsden-grens-taw-nap: (--soak) listed in /api/v1/health/sources; latest check under ${TWIN_MAX_AGE_MS / 3_600_000} h old, ok, with aligned timestamps; no failed check in 7 days; >= ${TWIN_MIN_CHECKS_7D} of the 168 hourly checks`,
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
      checkSourceHealth(sources, 'NL-1'),
      checkTier1(sources.data, 'NL-1'),
      checkReplay(health.data, sources.data, 'NL-1'),
    );

    // The P4b data API through Caddy (A§9.2). The snapshots ask for the server's own "now" from /meta, never this clock.
    const metaPage = await api('/api/v1/meta');
    const metaRead = readApi(metaPage, Meta, META_CACHE);
    const stationsPage = await api('/api/v1/stations');
    const stationsRead = readApi(stationsPage, Stations, STATIONS_CACHE);
    const snapPages: Record<string, Page | string> = {};
    const snapReads = new Map<string, ApiRead<Snapshot>>();
    for (const ask of SNAPSHOT_ASKS) {
      const at = snapshotAt(metaRead.data?.now, ask.back);
      if (at === undefined) continue;
      const page = await api(at.path);
      snapPages[ask.name] = page;
      snapReads.set(ask.name, readSnapshot(ask, at.ms, page));
    }
    const noindex: Record<string, Page | string> = {};
    for (const path of NOINDEX_PATHS) noindex[path] = await api(path);
    results.push(
      checkMeta(metaRead),
      checkBuild(metaRead.data),
      checkStations(stationsRead),
      ...SNAPSHOT_ASKS.map((ask) => checkSnapshot(ask, snapReads.get(ask.name))),
      checkOpenapi(readApi(await api('/api/v1/openapi.json'), OpenApi31, OPENAPI_CACHE)),
      checkApiParams(await api('/api/v1/meta?x=1')),
      checkNoindex(noindex),
      checkFresh('DE-1', snapReads.get('now')?.data, stationsRead.data, metaRead.data?.now),
      checkFresh('NL-1', snapReads.get('now')?.data, stationsRead.data, metaRead.data?.now),
    );

    // The P3 basemap (A§9.1): the manifest, every file it lists read with a 16-byte Range, the 404s, one pinned asset.
    const tile = (path: string, headers?: Readonly<Record<string, string>>) =>
      tryGet(`https://${domain}${path}`, net, headers);
    const manifest = readTilesManifest(await tile('/tiles/manifest.json'));
    results.push(checkTilesManifestPage(manifest));
    for (const file of tileFiles(manifest.manifest))
      results.push(checkTileFile(file, await tile(`/tiles/${file.file}`, TILE_HEADERS)));
    results.push(checkTilesPrevious(manifest));
    const missing: Record<string, Page | string> = {};
    for (const path of TILES_404_PATHS) missing[path] = await tile(path);
    const current = manifest.manifest?.current.basemap;
    const refused: Record<string, Page | string> = {};
    if (current !== undefined)
      for (const [label, headers] of TILE_416_REQUESTS) refused[label] = await tile(`/tiles/${current.file}`, headers);
    results.push(checkTiles404(missing), checkTiles416(current, refused), checkMapAsset(await tile(MAP_ASSET_PATH)));

    const body = (page: Page | string | undefined) => (typeof page === 'object' ? page.body : '');
    results.push(
      checkOwnerLeak(
        {
          '/status/*': `${capture.page?.body ?? ''}\n${ops.page?.body ?? ''}`,
          [HEALTH_PATHS[0]]: body(healthPage),
          [HEALTH_PATHS[1]]: body(sourcesPage),
          '/api/v1/meta': body(metaPage),
          '/api/v1/stations': body(stationsPage),
          ...Object.fromEntries(
            SNAPSHOT_ASKS.map((ask) => [`/api/v1/snapshot ${ask.name}`, body(snapPages[ask.name])]),
          ),
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
    results.push(checkTwin(readApi(await tryGet(`https://${domain}${HEALTH_PATHS[1]}`, net), HealthSources), now));
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
