// Outside-in production check (issue #16 P1b build item 10; A§11.2 step 4;
// PHASES §2.1 [agent-prod]). No SSH: only what any visitor can fetch. Exits
// non-zero on any miss and prints one PASS/FAIL/N-A line per check.
//
//   scripts/verify-prod.sh <domain>              TLS (IPv4 and IPv6), the exact A§12.2
//                                                headers, noindex, /healthz, both status
//                                                files, per-spec freshness, owner_specs,
//                                                the health API (contract, closed
//                                                parameters, DE-1 and NL-1 health, tier-1
//                                                freshness and replay, FR-1, CH-1, DE-7 and LU-1
//                                                health, tier-1 freshness and coverage since the
//                                                seed, CH-1's 10-minute and DE-7's 15-minute
//                                                request interval, DE-7's bytes per day, the owner-source
//                                                counts (healthy = total, none listed), loader lag), the data
//                                                API through Caddy (P4b: /meta with the
//                                                release commit, /stations, three snapshots
//                                                at the server's own clock, /openapi.json,
//                                                the closed parameters, noindex on the app,
//                                                /api and /tiles, DE-1, NL-1, FR-1 and CH-1
//                                                data under 45 minutes old, DE-7's under 90 and
//                                                LU-1's under 75, LU-1's label offset, the 25
//                                                Belgian points of catalogue §0.6), the
//                                                basemap tiles (P3: the manifest, a Range
//                                                read of every listed file, the 404s, the
//                                                416 for no Range or two ranges) and
//                                                the pinned map assets, the rivers (P6b: the
//                                                manifest, the overlay by Range, the reaches
//                                                file, the ODbL download and its attribution
//                                                in the page's script), and no
//                                                owner source, spec, host, canary or
//                                                private_basis in /status/* or any /api/v1
//                                                body above
//   scripts/verify-prod.sh <domain> --soak       + the 72 h soak: >= 99% per source, the
//                                                seed coverage, the byte baseline, the drill,
//                                                every twin pair over 7 days (TWIN_IDS)
//   scripts/verify-prod.sh <domain> --interval   + interval DE-6: 3 samples of capture.json 15 min apart (about 30 min)
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
import { gunzipSync, constants as zlibConstants, zstdDecompressSync } from 'node:zlib';
import { parse as parseYaml } from 'yaml';
import { loadRegistry, REGISTRY_DIR, type Registry, readSeed } from '../apps/server/src/capture/specs.ts';
import { CaptureStatus } from '../apps/server/src/capture/status.ts';
import { readRegistry } from '../apps/server/src/load/registry-sync.ts';
import { OpsStatus } from '../apps/server/src/watchdog/watchdog.ts';
import {
  BACKLOG_MAX_AGE_S,
  CANARIES,
  CANARY_RENDERINGS,
  checkReaches,
  DAY_MS,
  dayOf,
  dayStartMs,
  ForecastReaches,
  FramesFile,
  floorBucket,
  framesPath,
  Health,
  HealthSources,
  LAG_DEGRADED_S,
  LatestFile,
  Meta,
  ODBL_LICENCE,
  OSM_ATTRIBUTION,
  ReachesFile,
  RiversManifest,
  recentPath,
  SETTLE_MS,
  Snapshot,
  SnapshotFile,
  StaticForecastLatest,
  StaticMeta,
  StaticStations,
  StationRecent,
  Stations,
  settledPath,
  WarningsFile,
} from '../packages/contracts/src/index.ts';
import { StaticSources } from '../packages/contracts/src/static-owner.ts';
import { StatusFile } from '../packages/contracts/src/status.ts';
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
/** P5a criterion (Q7): at least this share of a source's expected tier-1 buckets, since the seed, holds a value. */
export const COVERAGE_MIN = 0.95;
/**
 * P5a: the shortest gap between two requests of `ch-1-lindas` (one variant) in the last 24 h. BAFU asks LINDAS
 * users for at most one download per 10 minutes: 600 s, less 5 s for the scheduling jitter of a fetch start.
 */
export const INTERVAL_SPEC = 'ch-1-lindas';
export const INTERVAL_MIN_S = 595;
/**
 * P5b: `de-7-messwerte` is captured hourly today and every 15 minutes once the owner enables it (the
 * RWS_PRUNE_APPLY switch of the budget test): never more often than every 15 minutes, less 5 s of jitter. The
 * detail prints the seconds, so the owner sees 3600 (hourly) or about 900 (every 15 minutes).
 */
export const DE7_SPEC = 'de-7-messwerte';
export const DE7_INTERVAL_MIN_S = 895;
/** P5b: the zstd bytes one UTC day of `de-7-messwerte` may store (96 fetches of a 0.9 MB ZIP). */
export const DE7_BYTES_MAX = 90_000_000;
/** The sources with an interval rule: the spec, the least gap in seconds, and why. */
export const INTERVAL_RULES = {
  'CH-1': { spec: INTERVAL_SPEC, minS: INTERVAL_MIN_S, why: 'BAFU: at most one download per 10 minutes' },
  'DE-7': { spec: DE7_SPEC, minS: DE7_INTERVAL_MIN_S, why: 'requested more often than every 15 minutes' },
} as const;
/**
 * The twin pairs of registry/twins.yaml (test/verify-prod.test.ts keeps the two lists equal): `--soak` asks for
 * each one, with the rules of the first.
 */
export const TWIN_IDS = [
  'eijsden-grens-taw-nap',
  'chooz-fr3-fr1-h',
  'uckange-fr3-fr1-q',
  'basel-ch1-de1-h',
  'perl-lu1-de1-h',
  'stadtbredimus-lu1-de1-h',
  'grevenmacher-lu1-de1-h',
] as const;
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

/** The owner-audience source IDs of registry/sources.yaml: no public document may list one. */
export const ownerSourceIds = (registry: Registry): string[] =>
  [...registry.sources].filter(([, src]) => src.audience === 'owner').map(([id]) => id);

/** Everything that identifies owner-audience data: source IDs, spec IDs, hosts, the canary. */
export function ownerTerms(registry: Registry): string[] {
  const sources = ownerSourceIds(registry);
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
export type ApiRead<T> = { data?: T; problems: string[] };

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

/**
 * P5a: the loader's coverage since the seed (Q7, over the source's tier-1 series) is at least 95%. The detail holds
 * the ratio, the series below 95%, the first instant counted and the gaps between loaded payloads (numbers and
 * instants only).
 */
export function checkCoverage(doc: HealthSources | undefined, id: string): Result {
  const check = `coverage ${id}`;
  if (doc === undefined) return noDocument(check, 'health/sources');
  const s = sourceOf(doc, id);
  if (s === undefined) return miss(check, 'not listed in /api/v1/health/sources');
  const c = s.coverage;
  if (c === null) return miss(check, 'no coverage yet');
  const newest = c.gaps.reduce<(typeof c.gaps)[number] | undefined>(
    (a, g) => (a === undefined || Date.parse(g.to) > Date.parse(a.to) ? g : a),
    undefined,
  );
  const detail =
    `${(100 * c.ratio).toFixed(1)}% of the expected buckets since ${c.from}, ` +
    `${c.series_below_95} of ${c.series} tier-1 series below 95%, ${c.gaps.length} gaps` +
    (newest === undefined ? '' : `, the newest from ${newest.from} to ${newest.to}`);
  return c.ratio >= COVERAGE_MIN ? pass(check, detail) : miss(check, `${detail}; below ${COVERAGE_MIN * 100}%`);
}

/**
 * P5a: CH-1 is not requested more often than BAFU allows (see `INTERVAL_MIN_S`). P5b: nor DE-7 more often than
 * every 15 minutes (`DE7_INTERVAL_MIN_S`); its detail says the seconds, 3600 while it is hourly.
 */
export function checkInterval(doc: HealthSources | undefined, id: keyof typeof INTERVAL_RULES = 'CH-1'): Result {
  const check = `interval ${id}`;
  if (doc === undefined) return noDocument(check, 'health/sources');
  const s = sourceOf(doc, id);
  if (s === undefined) return miss(check, 'not listed in /api/v1/health/sources');
  const rule = INTERVAL_RULES[id];
  const m = s.min_interval_s.find((x) => x.spec === rule.spec);
  if (m === undefined) return miss(check, 'no interval measured yet');
  const detail = `${rule.spec}: the shortest gap between two requests of one variant in 24 h is ${m.seconds} s`;
  return m.seconds >= rule.minS
    ? pass(check, `${detail}, not under ${rule.minS} s`)
    : miss(check, `${detail}, under ${rule.minS} s (${rule.why})`);
}

/**
 * P5b: the loader measured the LU-1 label offset on a recent UTC day (no older than 2 days before the server's own
 * `meta.now`, not in its future). Freshness is judged on the latest day the detector tried, decided or not (review
 * CR-4: quiet days on the impounded Perl reach decide nothing, and the alert `label_offset_unknown` says so); the
 * detail reports that day and the offset in force, from the latest day that decided it. Any offset passes; the
 * owner reads it (15 is the AGE file's habit). Numbers and dates only.
 */
export function checkLabelOffset(doc: HealthSources | undefined, now: string | undefined): Result {
  const check = 'label offset LU-1';
  if (doc === undefined) return noDocument(check, 'health/sources');
  if (now === undefined || Number.isNaN(Date.parse(now))) return noDocument(check, 'meta');
  const s = sourceOf(doc, 'LU-1');
  if (s === undefined) return miss(check, 'not listed in /api/v1/health/sources');
  const o = s.label_offset;
  if (o === null) return miss(check, 'no label offset measured yet');
  const today = new Date(Date.parse(now)).toISOString().slice(0, 10);
  const oldest = new Date(Date.parse(now) - 2 * 86_400_000).toISOString().slice(0, 10);
  const tried = o.decided
    ? `day ${o.day}: decided over ${o.n_aligned} instants (share ${o.share})`
    : `day ${o.day}: undecided (${o.n_aligned} instants)`;
  const offset = o.minutes === null ? 'no day decided yet' : `${o.minutes} min since ${o.decided_day}`;
  const detail = `${tried}; ${offset}`;
  if (o.day > today) return miss(check, `${detail}, after ${today}`);
  return o.day >= oldest ? pass(check, detail) : miss(check, `${detail}, older than ${oldest} (2 days before now)`);
}

/**
 * P5b: `de-7-messwerte` stored at most `DE7_BYTES_MAX` zstd bytes on each UTC day of the capture status
 * (today, partial, and the two days before). Hourly it is about a quarter of that.
 */
export function checkBytes(status: CaptureStatus): Result {
  const check = 'bytes DE-7';
  if (!status.specs.some((x) => x.spec === DE7_SPEC)) return miss(check, `${DE7_SPEC} is not in capture.json`);
  const days = status.days
    .filter((d) => d.bytes[DE7_SPEC] !== undefined)
    .map((d) => ({ date: d.date, bytes: d.bytes[DE7_SPEC] ?? 0 }));
  const most = days.reduce<(typeof days)[number] | undefined>(
    (a, d) => (a === undefined || d.bytes > a.bytes ? d : a),
    undefined,
  );
  if (most === undefined) return miss(check, `no bytes of ${DE7_SPEC} stored in the days of capture.json`);
  const detail = `${DE7_SPEC}: at most ${most.bytes} bytes on ${most.date} (${days.length} day(s) with bytes)`;
  return most.bytes <= DE7_BYTES_MAX
    ? pass(check, `${detail}, not over ${DE7_BYTES_MAX}`)
    : miss(check, `${detail}, over ${DE7_BYTES_MAX}`);
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
 * The soak criterion of a twin pair (P2b): its latest hourly check is fresh, has aligned timestamps, is ok and
 * finds no lag (P5b: the pairs that need a lag check carry the number), and none of the last 7 days' hourly checks
 * failed. A pair absent from the document fails: no data is not ok. Only counts and our own identifiers are printed.
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
  if (t.lag_min !== null && t.lag_min !== 0) problems.push(`the latest check finds a lag of ${t.lag_min} min`);
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

/** P7a: no owner-audience source ID as a whole word in any string value or object key of the public health documents. */
export function checkOwnerIds(bodies: Readonly<Record<string, string>>, ids: readonly string[]): Result {
  const strings = (doc: unknown): string[] =>
    typeof doc === 'string'
      ? [doc]
      : Array.isArray(doc)
        ? doc.flatMap(strings)
        : typeof doc === 'object' && doc !== null
          ? Object.entries(doc).flatMap(([key, value]) => [key, ...strings(value)])
          : [];
  const found = Object.entries(bodies).flatMap(([label, body]) => {
    const hits = [...new Set(strings(parseJson(body)).flatMap((v) => leaks(v, ids)))];
    return hits.length === 0 ? [] : [`${label}: ${hits.join(', ')}`];
  });
  return found.length === 0
    ? pass('owner ids', `none of ${ids.length} owner source IDs in ${Object.keys(bodies).join(', ')}`)
    : miss('owner ids', `found in ${found.join('; ')}`);
}

/** P7a: DE-6 is fetched at least every 10 minutes (manifest), judged on three samples of /status/capture.json. */
export const DE6_SPECS = ['de-6-stations', 'de-6-alerts'] as const;
export const DE6_MAX_AGE_S = 10 * 60 + 60;
export const DE6_SAMPLES = 3;
export const DE6_GAP_MS = 15 * 60_000;

/** Reads capture.json `n` times, `gapMs` apart; the reader and the sleeper are injected so tests do not wait. */
export async function sampleCapture(
  read: () => Promise<CaptureStatus | undefined>,
  sleep: (ms: number) => Promise<void>,
  n = DE6_SAMPLES,
  gapMs = DE6_GAP_MS,
): Promise<(CaptureStatus | undefined)[]> {
  const out: (CaptureStatus | undefined)[] = [];
  for (let i = 0; i < n; i += 1) {
    if (i > 0) await sleep(gapMs);
    out.push(await read());
  }
  return out;
}

export function checkIntervalDe6(samples: readonly (CaptureStatus | undefined)[]): Result {
  const check = 'interval DE-6';
  const problems: string[] = [];
  const ages: string[] = [];
  for (const spec of DE6_SPECS) {
    const ageS: number[] = [];
    const successes: number[] = [];
    for (const [i, doc] of samples.entries()) {
      const st = doc?.specs.find((x) => x.spec === spec);
      const n = i + 1;
      if (doc === undefined) problems.push(`${spec}: sample ${n} unreadable`);
      else if (st === undefined) problems.push(`${spec}: sample ${n} has no such spec`);
      else if (st.last_success === null) problems.push(`${spec}: sample ${n} has no last_success`);
      else {
        const ls = Date.parse(st.last_success);
        successes.push(ls);
        const age = Math.round((Date.parse(doc.generated_at) - ls) / 1000);
        ageS.push(age);
        if (age > DE6_MAX_AGE_S) problems.push(`${spec}: sample ${n} is ${age} s old, over ${DE6_MAX_AGE_S}`);
      }
    }
    const [first, last] = [successes[0], successes[successes.length - 1]];
    if (first !== undefined && last !== undefined && !(last > first))
      problems.push(`${spec}: last_success did not advance`);
    ages.push(`${spec} ${ageS.join('/')} s`);
  }
  return problems.length === 0 ? pass(check, `ages ${ages.join(', ')}`) : miss(check, problems.join('; '));
}

/** P5c: BE-3, LU-2, LU-3 and LU-4 at least are owner sources (DE-2 and DE-3 are too): fewer means a source went missing. */
export const OWNER_SOURCES_MIN = 4;
/**
 * P5c: the station-id prefixes of the owner sources that have stations (BE-3 `be.spw.`, LU-2 `lu.age-json.`; LU-3 and
 * LU-4 use the public LU-1 slugs). Judged beside the owner rows of registry/stations/*.yaml, so a prefix change that
 * forgets this list still fails on the prefix of a row (test/verify-prod.test.ts).
 */
export const OWNER_STATION_PREFIXES = ['be.spw.', 'lu.age-json.'] as const;

/** The ids of the owner-audience station rows of the registry (every registry/stations/*.yaml, as readRegistry reads them). */
export const ownerStationIds = (stations: readonly { id: string; audience: string }[]): string[] =>
  stations.filter((st) => st.audience === 'owner').map((st) => st.id);

/**
 * P5c: the public health/sources document counts the owner sources (`owner_sources`, at least `OWNER_SOURCES_MIN`)
 * and lists none of them in `sources`. `total` counts the owner sources the registry sync of `migrate` wrote
 * (captured or not), so this check holds without any capture (the CI deploy job gates on it). Counts only: the
 * detail never names a source.
 */
export function checkOwnerSources(r: ApiRead<HealthSources>, ownerIds: readonly string[]): Result {
  const check = 'owner sources';
  if (r.data === undefined || r.problems.length > 0) return noDocument(check, 'health/sources', r);
  const { total } = r.data.owner_sources;
  const listed = r.data.sources.filter((src) => ownerIds.includes(src.id)).length;
  const problems: string[] = [];
  if (total < OWNER_SOURCES_MIN) problems.push(`${total} owner sources, at least ${OWNER_SOURCES_MIN} expected`);
  if (listed > 0) problems.push(`${listed} owner sources listed in sources`);
  return problems.length === 0
    ? pass(check, `${total} owner sources (at least ${OWNER_SOURCES_MIN}), none listed in sources`)
    : miss(check, problems.join('; '));
}

/**
 * P5c (review SR-8): every owner source is healthy (`owner_sources.healthy = total`). Apart from `owner sources`,
 * because it needs live capture: the CI deploy job lets it fail, never the leak half. Counts only.
 */
export function checkOwnerHealth(r: ApiRead<HealthSources>): Result {
  const check = 'owner health';
  if (r.data === undefined || r.problems.length > 0) return noDocument(check, 'health/sources', r);
  const { healthy, total } = r.data.owner_sources;
  const detail = `${healthy} of ${total} owner sources healthy`;
  return healthy === total ? pass(check, detail) : miss(check, detail);
}

/**
 * P5c: /api/v1/stations holds no owner station: not one of the owner rows of the registry (`ownerIds`) and none under
 * an owner station-id prefix. A leak is judged whatever else is off with the answer (`api stations` judges the
 * headers); the detail counts and names no id.
 */
export function checkOwnerStations(r: ApiRead<Stations>, ownerIds: ReadonlySet<string>): Result {
  const check = 'owner stations';
  if (r.data === undefined) return noDocument(check, 'stations', r);
  const n = r.data.stations.length;
  const hits = r.data.stations.filter(
    (st) => ownerIds.has(st.id) || OWNER_STATION_PREFIXES.some((p) => st.id.startsWith(p)),
  ).length;
  if (hits > 0) return miss(check, `${hits} of ${n} stations are owner stations`);
  if (r.problems.length > 0) return noDocument(check, 'stations', r);
  return pass(check, `${n} public stations checked, none an owner station`);
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

// ---------------------------------------------------------------- the rivers (P6b)

export const RIVERS_MANIFEST_PATH = '/data/v1/rivers/manifest.json';
/** The first bytes of the ODbL download that are read, gunzipped: the header comes before the features. */
export const RIVERS_DOWNLOAD_RANGE = 'bytes=0-65535';
/** The gzip download is gzip data, never a transfer coding: Caddy must not encode it, whatever the client offers. */
export const RIVERS_DOWNLOAD_HEADERS = { 'accept-encoding': 'gzip, zstd' } as const;

export type RiversRead = { manifest?: RiversManifest; problems: string[] };

/** `/data/v1/rivers/manifest.json`: 200, JSON, `Cache-Control` exactly max-age=60 and a `RiversManifest` (strict). */
export function readRiversManifest(page: Page | string): RiversRead {
  const r = readApi(page, RiversManifest, MANIFEST_CACHE);
  return r.data === undefined ? { problems: r.problems } : { manifest: r.data, problems: r.problems };
}

export function checkRiversManifest(r: RiversRead): Result {
  const m = r.manifest;
  return m !== undefined && r.problems.length === 0
    ? pass(
        'rivers manifest',
        `200, ${MANIFEST_CACHE}, current ${m.current.version} (${m.current.tag}), previous ${m.previous?.version ?? 'none'}`,
      )
    : miss('rivers manifest', r.problems.join('; ') || 'no valid manifest');
}

/** The overlay: a 16-byte Range of `/tiles/<manifest tiles file>` is 206, immutable, not encoded, PMTiles v3. */
export function checkRiversTiles(m: RiversManifest | undefined, page: Page | string | undefined): Result {
  const check = 'rivers tiles';
  if (m === undefined) return miss(check, 'no valid manifest');
  if (page === undefined || typeof page === 'string') return miss(check, page ?? 'not asked');
  const f = m.current.tiles;
  const problems: string[] = [];
  if (page.status !== 206) problems.push(`status ${page.status}, want 206`);
  const range = page.headers['content-range'];
  if (range !== `bytes 0-15/${f.bytes}`) problems.push(`content-range ${show(range)}, want bytes 0-15/${f.bytes}`);
  const cache = page.headers['cache-control'];
  if (cache !== TILE_CACHE) problems.push(`cache-control ${show(cache)}`);
  const encoding = page.headers['content-encoding'];
  if (encoding !== undefined) problems.push(`content-encoding ${show(encoding)}`);
  if (!page.body.startsWith(PMTILES_MAGIC)) problems.push('not a PMTiles v3 file');
  return problems.length === 0
    ? pass(check, `${f.file}: 206, bytes 0-15/${f.bytes}, immutable, no Content-Encoding, PMTiles v3`)
    : miss(check, problems.join('; '));
}

/**
 * The reaches file of the current release: 200, immutable JSON, the `ReachesFile` contract with `checkReaches`
 * clean, the manifest's version, and every station of it a station of `/api/v1/stations` (a station the public API
 * does not list is one the public site must not name). The leak half is the `owner leak` check (the body is in it).
 */
export function checkRiversReaches(
  m: RiversManifest | undefined,
  page: Page | string | undefined,
  stationIds: ReadonlySet<string> | undefined,
): Result {
  const check = 'rivers reaches';
  if (m === undefined) return miss(check, 'no valid manifest');
  const r = readApi(page ?? 'not asked', ReachesFile, TILE_CACHE);
  if (r.data === undefined) return miss(check, r.problems.join('; '));
  const problems = [...r.problems];
  const f = r.data;
  const inconsistent = checkReaches(f);
  if (inconsistent.length > 0) problems.push(`${inconsistent.length} inconsistencies (first: ${inconsistent[0]})`);
  if (f.version !== m.current.version) problems.push(`version ${f.version}, the manifest says ${m.current.version}`);
  if (stationIds === undefined) problems.push('no valid /api/v1/stations to compare with');
  else {
    const unknown = f.stations.filter((st) => !stationIds.has(st.id)).length;
    if (unknown > 0) problems.push(`${unknown} of ${f.stations.length} stations are not in /api/v1/stations`);
  }
  return problems.length === 0
    ? pass(check, `${m.current.reaches.file}: ${f.reaches.length} reaches, ${f.stations.length} stations, all public`)
    : miss(check, problems.join('; '));
}

/**
 * What the first bytes of the download say, gunzipped (a truncated stream is fine: only what inflated is read): the
 * OSM attribution and the licence are keys that come before `"features"`.
 */
export function downloadHeader(bytes: Buffer): { text: string; problems: string[] } {
  try {
    const text = gunzipSync(bytes, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString('utf8');
    return { text, problems: [] };
  } catch {
    return { text: '', problems: ['the first bytes do not inflate as gzip'] };
  }
}

/**
 * The ODbL download (HEAD, then a 64 KiB Range): `application/gzip`, no `Content-Encoding`, immutable, the manifest's
 * length; and the gunzipped start holds `"attribution": "© OpenStreetMap contributors"` and `"licence": "ODbL-1.0"`
 * before `"features"`.
 */
export function checkRiversDownload(
  m: RiversManifest | undefined,
  head: Page | string | undefined,
  part: Page | string | undefined,
): Result {
  const check = 'rivers download';
  if (m === undefined) return miss(check, 'no valid manifest');
  if (head === undefined || typeof head === 'string') return miss(check, `HEAD: ${head ?? 'not asked'}`);
  if (part === undefined || typeof part === 'string') return miss(check, `Range: ${part ?? 'not asked'}`);
  const f = m.current.download;
  const problems: string[] = [];
  if (head.status !== 200) problems.push(`HEAD status ${head.status}, want 200`);
  if (head.headers['content-type'] !== 'application/gzip')
    problems.push(`content-type ${show(head.headers['content-type'])}, want application/gzip`);
  if (head.headers['content-encoding'] !== undefined)
    problems.push(`content-encoding ${show(head.headers['content-encoding'])}`);
  if (head.headers['cache-control'] !== TILE_CACHE)
    problems.push(`cache-control ${show(head.headers['cache-control'])}`);
  if (head.headers['content-length'] !== String(f.bytes))
    problems.push(`content-length ${show(head.headers['content-length'])}, want ${f.bytes}`);
  if (part.status !== 206 && part.status !== 200) problems.push(`Range status ${part.status}, want 206`);
  if (part.headers['content-encoding'] !== undefined)
    problems.push(`Range content-encoding ${show(part.headers['content-encoding'])}`);
  const { text, problems: inflate } = downloadHeader(part.bytes ?? Buffer.alloc(0));
  problems.push(...inflate);
  if (inflate.length === 0) {
    const features = text.indexOf('"features"');
    const attribution = new RegExp(`"attribution"\\s*:\\s*"${OSM_ATTRIBUTION}"`).exec(text);
    const licence = new RegExp(`"licence"\\s*:\\s*"${ODBL_LICENCE.replace('.', '\\.')}"`).exec(text);
    if (features < 0) problems.push('no "features" key in the first 64 KiB');
    if (attribution === null || (features >= 0 && attribution.index > features))
      problems.push('no OSM attribution before "features"');
    if (licence === null || (features >= 0 && licence.index > features))
      problems.push(`no licence ${ODBL_LICENCE} before "features"`);
  }
  return problems.length === 0
    ? pass(
        check,
        `${f.file}: application/gzip, no Content-Encoding, immutable, ${f.bytes} bytes; attribution and ${ODBL_LICENCE} before "features"`,
      )
    : miss(check, problems.join('; '));
}

/** The first `/assets/*.js` the page references (the entry chunk). */
export const entryScript = (html: string): string | undefined =>
  /<script[^>]*\ssrc="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];

/** The page's own script names the ODbL (the footer text of the river network, P6b): a plain substring. */
export function checkRiversAttribution(script: Page | string | undefined): Result {
  const check = 'rivers attribution';
  if (script === undefined) return miss(check, 'the page references no script');
  if (typeof script === 'string') return miss(check, script);
  if (script.status !== 200) return miss(check, `script status ${script.status}`);
  return script.body.includes('ODbL')
    ? pass(check, 'the entry script of the page names the ODbL')
    : miss(check, 'the entry script of the page does not name the ODbL');
}

// ---------------------------------------------------------------- data API (P4b)

/** Cache-Control of the fixed data routes (A§9.2), compared exactly. */
export const META_CACHE = 'public, max-age=60';
export const STATIONS_CACHE = 'public, max-age=300';
export const OPENAPI_CACHE = 'public, max-age=300';
/** The public sources that /meta and /stations must show (those with a loader: P2, FR-1 and CH-1 since P5a, DE-7 and LU-1 since P5b). */
export const API_SOURCES = ['NL-1', 'DE-1', 'FR-1', 'CH-1', 'DE-7', 'LU-1'] as const;
/** NL-1 locations on Belgian soil (catalogue §0.6): the stations are `nl.rws.<code>`; the 18 FR-1 partners are in the seed. */
export const BELGIAN_NL1 = [
  'antwerpen',
  'lixhebiefaval',
  'maaseik',
  'herenlaak',
  'lanaken',
  'kanne',
  'smeermaas.zuidwillemsvaart',
] as const;
/** P5a criterion: this share (percent) of the Belgian points has a value no older than 3 h at the server's now. */
export const BELGIAN_FRESH_PCT = 90;
export const BELGIAN_MAX_AGE_S = 3 * 3600;
/** A source is fresh when one of its series has a value in the current snapshot no older than this at meta.now (45 min). */
export const FRESH_MAX_AGE_S = 2700;
/**
 * P5b: the sources that are slower than that. DE-7 is captured hourly (90 min); LU-1 labels its values 15 minutes
 * late and the file is published 11 to 25 minutes after them (75 min with the quarter-hour capture).
 */
export const FRESH_MAX_AGE_BY_SOURCE: ReadonlyMap<string, number> = new Map([
  ['DE-7', 5400],
  ['LU-1', 4500],
]);
export const freshLimit = (source: string): number => FRESH_MAX_AGE_BY_SOURCE.get(source) ?? FRESH_MAX_AGE_S;
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

/** P7b: every value of the "now" snapshot carries a state and a basis (null exactly for no_ref); counts only in the detail. */
export function checkStates(snapshot: Snapshot | undefined): Result {
  if (snapshot === undefined) return miss('api states', 'no valid "now" snapshot');
  const problems = new Set<string>();
  let classed = 0;
  let sections = 0;
  let noRef = 0;
  for (const v of snapshot.values) {
    if (v.state === 'no_ref') noRef++;
    else classed++;
    if ((v.basis === null) !== (v.state === 'no_ref')) problems.add('a basis that does not match no_ref');
    if (v.section) {
      sections++;
      if (v.basis?.kind !== 'area' || v.basis.measure !== 'area') problems.add('a section without an area basis');
      if (v.area !== undefined) problems.add('a section with an area beside it');
    } else if (v.basis?.kind === 'area') problems.add('an area basis without section');
    if (v.nap !== undefined && v.zero !== undefined) problems.add('nap and zero together');
  }
  return problems.size === 0
    ? pass(
        'api states',
        `${snapshot.values.length} values, ${classed} classed, ${sections} by section, ${noRef} no_ref`,
      )
    : miss('api states', [...problems].join('; '));
}

/**
 * P7b: /api/v1/health/sources carries the classification coverage; numbers and country codes only. The detail names
 * how many of the classed tier-1 stations are classed only by a section (review CR-4: D10's mode leaves them out).
 */
export function checkClassCoverage(doc: HealthSources | undefined): Result {
  const c = doc?.classification;
  if (c === undefined || c === null) return miss('class coverage', 'classification is null or absent');
  const ratio = c.tier1.ratio === null ? 'none' : `${(c.tier1.ratio * 100).toFixed(1)}%`;
  const countries = c.countries.map((k) => `${k.country} ${k.tier1.classed}/${k.tier1.stations}`).join(', ');
  return pass(
    'class coverage',
    `tier-1 ${ratio} (${c.tier1.by_section} by section), mode ${c.mode}${countries === '' ? '' : `; ${countries}`}`,
  );
}

/**
 * P8a: the newest NL-1 forecast run, at most this many seconds old. RWS issues ONE run a day (a series' new run is
 * first seen between 05:25 and 08:45 UTC and every run ends at 05:00 UTC two days later; the owner's D2 export of
 * 2026-10-03), so the newest run across the series is up to about 21 hours old, never 7: 30 hours is a day of
 * slack. The currency of each series is judged by `current` instead.
 */
export const FORECAST_NL1_MAX_AGE_S = 30 * 3600;
/** P8a: at least this share of the NL-1 series with a run have a current one (the run still reaches now). */
export const FORECAST_NL1_CURRENT_MIN = 0.9;

/**
 * P8a: NL-1 forecast runs are flowing: `/api/v1/health/sources` lists NL-1 with a `forecast` whose newest run is at
 * most `FORECAST_NL1_MAX_AGE_S` old and of whose series at least `FORECAST_NL1_CURRENT_MIN` have a current run.
 * Needs live capture (the CI deploy job lets it fail). Numbers only.
 */
export function checkForecastNl1(doc: HealthSources | undefined): Result {
  const check = 'forecast NL-1';
  if (doc === undefined) return noDocument(check, 'health/sources');
  const s = sourceOf(doc, 'NL-1');
  if (s === undefined) return miss(check, 'NL-1 is not listed in /api/v1/health/sources');
  const f = s.forecast;
  if (f === null) return miss(check, 'NL-1 has stored no forecast run yet');
  const hours = (f.run_age_s / 3600).toFixed(1);
  const detail = `${f.current} of ${f.series} series have a current run, the newest was issued ${hours} h ago (${f.issued_at})`;
  const problems: string[] = [];
  if (f.run_age_s > FORECAST_NL1_MAX_AGE_S)
    problems.push(`the newest run is over ${FORECAST_NL1_MAX_AGE_S / 3600} h old`);
  if (f.series === 0 || f.current / f.series < FORECAST_NL1_CURRENT_MIN)
    problems.push(`under ${FORECAST_NL1_CURRENT_MIN * 100}% of the series have a current run`);
  return problems.length === 0 ? pass(check, detail) : miss(check, `${detail}; ${problems.join('; ')}`);
}

/**
 * P8b: the newest CH-4 forecast run, at most this many seconds old. BAFU starts a new run every 2 to 6 hours and
 * the capture is hourly, so the newest run is about 7 hours old at worst; 12 hours is slack for a missed capture or
 * two. `issued_at` is inferred (our first fetch of the run), so it reads younger than BAFU's own issue time, never older.
 */
export const FORECAST_CH4_MAX_AGE_S = 12 * 3600;
/**
 * P8b (known gap): the seeded CH-4 stations whose `q_forecast` answered 404 every hour of the production archive
 * (2026-09-30 to 2026-10-04): 13 lake stations (BAFU publishes no forecast plot of a lake level) and 2646. They are
 * captured and never have a run, so `forecast CH-4` does not expect one.
 */
export const CH4_NO_FORECAST: readonly string[] = [
  '2004',
  '2022',
  '2023',
  '2027',
  '2032',
  '2043',
  '2093',
  '2101',
  '2118',
  '2207',
  '2208',
  '2209',
  '2642',
  '2646',
];

/**
 * P8b: how many CH-1 series should have a CH-4 run: the stations of registry/seed/ch-4.csv whose CH-1 series (`<id>/Q`,
 * else `<id>/W` for a lake) exists, is primary and is not `audience: off` (an off series stores nothing; 15 of the
 * 54 seeded stations are on non-Rhine water bodies), less the `CH4_NO_FORECAST` stations. Read from the registry
 * files at run time, so a seed or scope change moves it.
 */
export function ch4ExpectedSeries(
  seed: readonly Readonly<Record<string, string>>[] = readSeed(REGISTRY_DIR, 'ch-4'),
  stations: readonly { source: string; provider_key: string; role: string; audience: string }[] = readRegistry()
    .stations,
): number {
  const ch1 = new Map(stations.filter((st) => st.source === 'CH-1').map((st) => [st.provider_key, st]));
  return seed.filter((row) => {
    const id = row.id ?? '';
    const st = ch1.get(`${id}/Q`) ?? ch1.get(`${id}/W`);
    return st?.role === 'primary' && st.audience !== 'off' && !CH4_NO_FORECAST.includes(id);
  }).length;
}

/** CH-4's audience in registry/sources.yaml (C13: public unless BAFU objects, then owner). */
let ch4AudienceCache: string | undefined;
export const ch4Audience = (): string =>
  (ch4AudienceCache ??= readRegistry().sources.find((s) => s.id === 'CH-4')?.audience ?? 'off');

/**
 * P8b: CH-4 forecast runs are flowing: `/api/v1/health/sources` lists CH-4 with a `forecast` whose newest run is at
 * most `FORECAST_CH4_MAX_AGE_S` old and that has a run on at least `expected` series (`ch4ExpectedSeries`).
 * Needs live capture (the CI deploy job lets it fail). Numbers only. After a C13 objection (CH-4 no longer public, a
 * reviewed registry change) public health holds no CH-4: the check passes and says why (review F2).
 */
export function checkForecastCh4(
  doc: HealthSources | undefined,
  expected: number = ch4ExpectedSeries(),
  audience: string = ch4Audience(),
): Result {
  const check = 'forecast CH-4';
  if (audience !== 'public') return pass(check, `CH-4 is ${audience} in the registry (C13): not in public health`);
  if (doc === undefined) return noDocument(check, 'health/sources');
  const s = sourceOf(doc, 'CH-4');
  if (s === undefined) return miss(check, 'CH-4 is not listed in /api/v1/health/sources');
  const f = s.forecast;
  if (f === null) return miss(check, 'CH-4 has stored no forecast run yet');
  const hours = (f.run_age_s / 3600).toFixed(1);
  const detail = `${f.series} of ${expected} expected series have a run, the newest was issued ${hours} h ago (${f.issued_at})`;
  const problems: string[] = [];
  if (f.run_age_s > FORECAST_CH4_MAX_AGE_S)
    problems.push(`the newest run is over ${FORECAST_CH4_MAX_AGE_S / 3600} h old`);
  if (f.series < expected) problems.push(`${expected - f.series} expected series have no run`);
  return problems.length === 0 ? pass(check, detail) : miss(check, `${detail}; ${problems.join('; ')}`);
}

/** The ids of the reach rows of registry/forecast-reaches.yaml, in order: the public coverage report has exactly these. */
export const reachIds = (): string[] =>
  ForecastReaches.parse(
    parseYaml(readFileSync(join(root, 'registry/forecast-reaches.yaml'), 'utf8'), { maxAliasCount: 0 }),
  ).reaches.map((r) => r.id);

/**
 * P8a: /api/v1/health/sources carries the public forecast coverage (catalogue §0.5): present, one entry for each
 * reach row of registry/forecast-reaches.yaml in order, a reach without a visible source says what could change it
 * (`after_permission` or `none_publishes`), and no owner-audience source ID (nor `BfG`, the agency behind DE-2 and
 * DE-3) appears anywhere in it. It needs no fresh data, so it must PASS on the CI fixture data. Counts only.
 */
export function checkForecastCoverage(
  doc: HealthSources | undefined,
  ownerIds: readonly string[],
  expectedIds: readonly string[] = reachIds(),
): Result {
  const check = 'forecast coverage';
  if (doc === undefined) return noDocument(check, 'health/sources');
  const c = doc.forecast_coverage;
  if (c === null) return miss(check, 'forecast_coverage is null (the report could not be computed)');
  const problems: string[] = [];
  const ids = c.reaches.map((r) => r.id);
  if (ids.join() !== expectedIds.join())
    problems.push('the reaches are not those of registry/forecast-reaches.yaml, in order');
  const bare = c.reaches.filter(
    (r) => r.no_official_forecast && r.after_permission.length + r.none_publishes.length === 0,
  ).length;
  if (bare > 0) problems.push(`${bare} reaches with no official forecast say nothing of what could change it`);
  const strings = (v: unknown): string[] =>
    typeof v === 'string'
      ? [v]
      : Array.isArray(v)
        ? v.flatMap(strings)
        : typeof v === 'object' && v !== null
          ? Object.entries(v).flatMap(([key, value]) => [key, ...strings(value)])
          : [];
  const found = [...new Set(strings(c).flatMap((t) => leaks(t, [...ownerIds, 'BfG'])))];
  if (found.length > 0) problems.push(`names an owner source or agency: ${found.join(', ')}`);
  const none = c.reaches.filter((r) => r.no_official_forecast).length;
  const detail =
    `${c.total.covered} of ${c.total.stations} first-release stations have a current run, ` +
    `${c.reaches.length} reaches (${none} with no official forecast), ${c.other.stations} stations in no reach`;
  return problems.length === 0 ? pass(check, detail) : miss(check, `${detail}; ${problems.join('; ')}`);
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
 * At least one series of the source has a value in the snapshot no older than 45 minutes (`freshLimit`: 90 for
 * DE-7, 75 for LU-1) at the server's own now (`meta.now`): the snapshot's `ageSeconds` counts from its `t`, which
 * is floored to 10 minutes.
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
  const limit = freshLimit(source);
  return newest <= limit ? pass(check, detail) : miss(check, `${detail}, over ${limit} s`);
}

/**
 * The 25 Belgian points of catalogue §0.6 as station IDs: the 7 NL-1 locations and the FR-1 partners of
 * `registry/seed/fr-1-be.csv` (read from the file, never listed here).
 */
export function belgianIds(partners: readonly Readonly<Record<string, string>>[] = readSeed(REGISTRY_DIR, 'fr-1-be')) {
  return [...BELGIAN_NL1.map((code) => `nl.rws.${code}`), ...partners.map((r) => `fr.sandre.${r.code_station ?? ''}`)];
}

/**
 * P5a [agent-prod]: every Belgian point is a station of /api/v1/stations (that view shows primary series only, so
 * presence means primary), and at least 90% of them have a value in the "now" snapshot no older than 3 hours at the
 * server's own now (`meta.now`). The detail names the missing and the stale points (our own IDs, never provider text).
 */
export function checkBelgianSet(
  ids: readonly string[],
  stations: Stations | undefined,
  snapshot: Snapshot | undefined,
  now: string | undefined,
): Result {
  const check = 'belgian set';
  if (snapshot === undefined || stations === undefined || now === undefined)
    return noDocument(check, snapshot === undefined ? 'snapshot' : stations === undefined ? 'stations' : 'meta');
  if (ids.length === 0) return miss(check, 'no Belgian point to look for');
  const nowMs = Date.parse(now);
  const ageOf = new Map(snapshot.values.map((v) => [v.series, Math.round((nowMs - Date.parse(v.ts)) / 1000)]));
  const byId = new Map(stations.stations.map((st) => [st.id, st]));
  const missing: string[] = [];
  const stale: string[] = [];
  for (const id of ids) {
    const st = byId.get(id);
    if (st === undefined) missing.push(id);
    else if (!st.series.some((x) => (ageOf.get(x.id) ?? Number.POSITIVE_INFINITY) <= BELGIAN_MAX_AGE_S)) stale.push(id);
  }
  const present = ids.length - missing.length;
  const fresh = present - stale.length;
  const detail =
    `present ${present}/${ids.length}, fresh ${fresh}/${ids.length} (a value no older than ${BELGIAN_MAX_AGE_S / 3600} h)` +
    (missing.length === 0 ? '' : `; missing: ${missing.join(', ')}`) +
    (stale.length === 0 ? '' : `; stale: ${stale.join(', ')}`);
  return missing.length === 0 && fresh * 100 >= ids.length * BELGIAN_FRESH_PCT
    ? pass(check, detail)
    : miss(check, detail);
}

// ---------------------------------------------------------------- static publisher (P9a)

/** Cache-Control per class of /data/v1 (plan §4.1, deploy/web/site.caddy), compared exactly. */
export const STATIC_CACHE = {
  live: 'public, max-age=60, stale-while-revalidate=300',
  recent: 'public, max-age=300, stale-while-revalidate=600',
  slow: 'public, max-age=300',
  immutable: 'public, max-age=31536000, immutable',
  warnings: 'public, max-age=60',
  status: 'public, max-age=30',
} as const;
export const GEOJSON = 'application/geo+json';
/** meta.latestFrom may trail the loader's newest commit by this much (C18). */
export const STATIC_LAG_MAX_S = 120;
/** A settled day renders in under this (C23; [agent-prod] only, CI has no settled day). */
export const RERENDER_MAX_S = 60;
export const RUNTIME_CONFIG_BODY = '{"audience":"public"}';

/**
 * One answer of a /data/v1 file: 200, exactly `cache`, the media type `type`, the contract and no owner term in the
 * body. `data` is set whenever the body is the contract document, whatever else is wrong.
 */
export function readStatic<T>(
  page: Page | string,
  schema: Contract<T>,
  cache: string,
  type = 'application/json',
  terms: readonly string[] = [],
): ApiRead<T> {
  if (typeof page === 'string') return { problems: [page] };
  const problems: string[] = [];
  if (page.status !== 200) problems.push(`status ${page.status}`);
  const sent = (page.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (sent !== type) problems.push(`content-type ${JSON.stringify(page.headers['content-type'] ?? '')}`);
  if (page.headers['cache-control'] !== cache)
    problems.push(`cache-control ${JSON.stringify(page.headers['cache-control'] ?? '')}`);
  const parsed = schema.safeParse(parseJson(page.body));
  if (!parsed.success) problems.push('not the contract document');
  const hits = leaks(page.body, terms);
  if (hits.length > 0) problems.push(`owner term ${hits.join(', ')}`);
  return parsed.success ? { data: parsed.data, problems } : { problems };
}

const staticMiss = (check: string, r: ApiRead<unknown>, extra: string[]) =>
  extra.length === 0 && r.problems.length === 0 ? undefined : miss(check, [...r.problems, ...extra].join('; '));

export function checkStaticMeta(r: ApiRead<StaticMeta>): Result {
  const extra: string[] = [];
  for (const id of API_SOURCES)
    if (r.data !== undefined && !r.data.sources.some((s) => s.id === id)) extra.push(`${id} is not listed in sources`);
  return (
    staticMiss('static meta', r, extra) ??
    pass(
      'static meta',
      `200, ${STATIC_CACHE.live}, the StaticMeta contract, latestFrom ${r.data?.latestFrom ?? 'null'}, ${Object.keys(r.data?.dayVersions ?? {}).length} day versions`,
    )
  );
}

/** latest.json carries the seriesHash of stations.json (one source of truth for the series order). */
export function checkStaticLatest(r: ApiRead<LatestFile>, stations: StaticStations | undefined): Result {
  const extra: string[] = [];
  if (stations === undefined) extra.push('no valid stations.json to compare seriesHash with');
  else if (r.data !== undefined && r.data.seriesHash !== stations.seriesHash)
    extra.push(`seriesHash ${r.data.seriesHash} is not stations.json's ${stations.seriesHash}`);
  return (
    staticMiss('static latest', r, extra) ??
    pass(
      'static latest',
      `200, ${STATIC_CACHE.live}, the LatestFile contract, ${r.data?.series.length} series, seriesHash ${r.data?.seriesHash}`,
    )
  );
}

export function checkStaticStations(r: ApiRead<StaticStations>): Result {
  return (
    staticMiss('static stations', r, []) ??
    pass(
      'static stations',
      `200, ${STATIC_CACHE.slow}, the StaticStations contract, ${r.data?.stations.length} stations`,
    )
  );
}

/** Public ids only: the contract refuses an owner id, and no owner id or term may occur anywhere in the body. */
export function checkStaticSources(r: ApiRead<StaticSources>): Result {
  return (
    staticMiss('static sources', r, []) ??
    pass('static sources', `200, ${STATIC_CACHE.slow}, the StaticSources contract, ${r.data?.sources.length} sources`)
  );
}

/** The newest recent file: the current or the previous 10-minute bucket of the server's now. */
export const recentCandidates = (serverNow: string | undefined): { ms: number; path: string }[] => {
  const now = Date.parse(serverNow ?? '');
  if (Number.isNaN(now)) return [];
  return [0, 1].map((back) => {
    const ms = floorBucket(now) - back * 600_000;
    return { ms, path: recentPath(ms) };
  });
};

export function checkStaticRecent(r: ApiRead<SnapshotFile> | undefined, t: number | undefined): Result {
  if (r === undefined || t === undefined) return miss('static recent', 'no meta.now to ask for a bucket');
  const extra = r.data !== undefined && Date.parse(r.data.t) !== t ? [`t ${r.data.t} is not the bucket asked for`] : [];
  return (
    staticMiss('static recent', r, extra) ??
    pass(
      'static recent',
      `200, ${STATIC_CACHE.recent}, the SnapshotFile contract at ${r.data?.t}, ${r.data?.series.length} series`,
    )
  );
}

/** The newest day that is settled at `nowMs` and whether the web may expect a complete file for it. */
export type SettledAsk = { day: string; version: number; t: number; none?: string };
export function settledAsk(meta: StaticMeta | undefined, pendingDays: number | undefined): SettledAsk | undefined {
  if (meta === undefined) return undefined;
  const now = Date.parse(meta.now);
  const day = dayOf(now - SETTLE_MS - DAY_MS);
  const version = meta.dayVersions[day] ?? 1;
  // Midday of the day, or the first bucket of the display window when it begins later that day.
  const t = Math.max(dayStartMs(day) + 12 * 3_600_000, Date.parse(meta.displayStart));
  const ask: SettledAsk = { day, version, t };
  if (version === 0) ask.none = `day ${day} has version 0 (use the API)`;
  else if (dayStartMs(day) + DAY_MS <= Date.parse(meta.displayStart))
    ask.none = `day ${day} ends before the display window`;
  else if (pendingDays !== undefined && pendingDays > 0)
    ask.none = `day ${day} is pending (${pendingDays} pending days)`;
  return ask;
}

/** A sample of the newest settled day: immutable class; "none yet" (PASS) while no settled day is complete. */
export function checkStaticSettled(ask: SettledAsk | undefined, page: Page | string | undefined): Result {
  if (ask === undefined) return miss('static settled', 'no valid meta.json to pick a settled day from');
  const r = page === undefined ? undefined : readStatic(page, SnapshotFile, STATIC_CACHE.immutable);
  if (typeof page === 'object' && page.status === 404 && ask.none !== undefined)
    return pass('static settled', `none yet: ${ask.none}`);
  if (page === undefined) return pass('static settled', `none yet: ${ask.none ?? 'no sample asked'}`);
  const extra =
    r?.data !== undefined && Date.parse(r.data.t) !== ask.t ? [`t ${r.data.t} is not the bucket asked for`] : [];
  return (
    staticMiss('static settled', r ?? { problems: [] }, extra) ??
    pass(
      'static settled',
      `200, ${STATIC_CACHE.immutable}, day ${ask.day} v${ask.version} at ${r?.data?.t}, ${r?.data?.series.length} series`,
    )
  );
}

/** frames/recent.json (slow class) and, when a settled day is complete, its frames file (immutable). */
export function checkStaticFrames(
  recent: ApiRead<FramesFile>,
  ask: SettledAsk | undefined,
  settled: Page | string | undefined,
): Result {
  const extra: string[] = [];
  let tail = 'no settled day yet';
  if (
    ask !== undefined &&
    settled !== undefined &&
    !(typeof settled === 'object' && settled.status === 404 && ask.none !== undefined)
  ) {
    const s = readStatic(settled, FramesFile, STATIC_CACHE.immutable);
    extra.push(...s.problems.map((p) => `${framesPath(ask.day, ask.version)}: ${p}`));
    tail = `day ${ask.day} v${ask.version} ${STATIC_CACHE.immutable}`;
  } else if (ask?.none !== undefined) tail = `settled part: none yet (${ask.none})`;
  return (
    staticMiss('static frames', recent, extra) ??
    pass(
      'static frames',
      `200, ${STATIC_CACHE.slow}, the FramesFile contract, ${recent.data?.series.length} series; ${tail}`,
    )
  );
}

export function checkStaticForecast(r: ApiRead<StaticForecastLatest>): Result {
  return (
    staticMiss('static forecast', r, []) ??
    pass('static forecast', `200, ${STATIC_CACHE.slow}, the StaticForecastLatest contract, ${r.data?.runs.length} runs`)
  );
}

/** One station's series/{id}/recent.json, the id taken from stations.json. */
export function checkStaticSeries(r: ApiRead<StationRecent> | undefined, id: string | undefined): Result {
  if (r === undefined || id === undefined) return miss('static series', 'no station in stations.json to ask for');
  const extra = r.data !== undefined && r.data.station !== id ? [`station ${r.data.station} is not ${id}`] : [];
  return (
    staticMiss('static series', r, extra) ??
    pass(
      'static series',
      `200, ${STATIC_CACHE.slow}, the StationRecent contract of ${id}, ${r.data?.series.length} series`,
    )
  );
}

/** warnings/latest.geojson (application/geo+json, max-age=60) and yesterday's dated file when it exists (immutable). */
export function checkStaticWarnings(
  latest: ApiRead<WarningsFile>,
  yesterday: { day: string; page: Page | string } | undefined,
): Result {
  const extra: string[] = [];
  let tail = 'no dated file yet';
  if (yesterday !== undefined && !(typeof yesterday.page === 'object' && yesterday.page.status === 404)) {
    const y = readStatic(yesterday.page, WarningsFile, STATIC_CACHE.immutable);
    extra.push(...y.problems.map((p) => `${yesterday.day}: ${p}`));
    if (y.data !== undefined && y.data.day !== yesterday.day) extra.push(`${yesterday.day}: day ${y.data.day}`);
    tail = `${yesterday.day} ${STATIC_CACHE.immutable}`;
  }
  return (
    staticMiss('static warnings', latest, extra) ??
    pass(
      'static warnings',
      `200, ${STATIC_CACHE.warnings} ${GEOJSON}, ${latest.data?.features.length} features; ${tail}`,
    )
  );
}

/** status.json: max-age=30, the public contract (no owner source id, only the two ownerSources counts). */
export function checkStaticStatus(r: ApiRead<StatusFile>): Result {
  const extra =
    r.data === undefined
      ? []
      : [
          ...(r.data.sources.some((s) => /^(BE-3|LU-[234]|DE-[23])$|^CANARY/.test(s.id))
            ? ['an owner source is listed']
            : []),
        ];
  return (
    staticMiss('static status', r, extra) ??
    pass(
      'static status',
      `200, ${STATIC_CACHE.status}, the StatusFile contract, ${r.data?.sources.length} sources, ownerSources ${r.data?.ownerSources.healthy}/${r.data?.ownerSources.total}`,
    )
  );
}

const encodings = { zstd: (b: Buffer) => zstdDecompressSync(b), gzip: (b: Buffer) => gunzipSync(b) } as const;

/** meta.json asked with Accept-Encoding zstd and gzip: Content-Encoding, Vary, and the decompressed bytes equal the identity ones. */
export function checkStaticPrecompressed(
  identity: Page | string,
  got: Readonly<Record<keyof typeof encodings, Page | string>>,
): Result {
  const problems: string[] = [];
  if (typeof identity === 'string' || identity.status !== 200) problems.push('identity: no 200 answer');
  for (const enc of Object.keys(encodings) as (keyof typeof encodings)[]) {
    const p = got[enc];
    if (typeof p === 'string') {
      problems.push(`${enc}: ${p}`);
      continue;
    }
    if (p.status !== 200) problems.push(`${enc}: status ${p.status}`);
    if (p.headers['content-encoding'] !== enc)
      problems.push(`${enc}: content-encoding ${JSON.stringify(p.headers['content-encoding'] ?? null)}`);
    if (!/(?:^|,\s*)accept-encoding(?:\s*,|$)/i.test(p.headers.vary ?? ''))
      problems.push(`${enc}: vary ${JSON.stringify(p.headers.vary ?? null)}`);
    if (typeof identity !== 'string' && p.bytes !== undefined && p.headers['content-encoding'] === enc) {
      try {
        if (!encodings[enc](p.bytes).equals(identity.bytes ?? Buffer.from(identity.body)))
          problems.push(`${enc}: the decompressed body differs from the identity body`);
      } catch {
        problems.push(`${enc}: the body does not decompress`);
      }
    }
  }
  return problems.length === 0
    ? pass(
        'static precompressed',
        'meta.json: zstd and gzip with Content-Encoding, Vary: Accept-Encoding and the identity bytes',
      )
    : miss('static precompressed', problems.join('; '));
}

/** The publisher keeps up with the loader: health.loader.last_commit − meta.latestFrom <= 120 s; no commit yet is a PASS. */
export function checkStaticLag(health: Health | undefined, meta: StaticMeta | undefined): Result {
  const check = 'static lag';
  if (health === undefined) return noDocument(check, 'health');
  if (health.loader.last_commit === null) return pass(check, 'none yet: the loader has no commit');
  if (meta === undefined) return noDocument(check, 'static meta');
  if (meta.latestFrom === null)
    return miss(check, `the loader committed at ${health.loader.last_commit} and latest.json has no latestFrom`);
  const lag = (Date.parse(health.loader.last_commit) - Date.parse(meta.latestFrom)) / 1000;
  return lag <= STATIC_LAG_MAX_S
    ? pass(
        check,
        `latest.json shows data ${Math.max(lag, 0)} s behind the loader's last commit (<= ${STATIC_LAG_MAX_S} s)`,
      )
    : miss(check, `latest.json is ${lag} s behind the loader's last commit (limit ${STATIC_LAG_MAX_S} s)`);
}

/** C23: the last settled day rendered whole in under 60 s; none rendered yet is a PASS. */
export function checkStaticRerender(r: ApiRead<StatusFile>): Result {
  const check = 'static rerender';
  if (r.data === undefined) return noDocument(check, 'status', r);
  const d = r.data.publisher.lastDayRender;
  if (d === null) return pass(check, 'none yet: no settled day rendered');
  return d.seconds < RERENDER_MAX_S
    ? pass(check, `${d.day} v${d.version} in ${d.seconds} s (< ${RERENDER_MAX_S} s)`)
    : miss(check, `${d.day} v${d.version} took ${d.seconds} s (limit ${RERENDER_MAX_S} s)`);
}

/** /runtime-config.json: exactly {"audience":"public"}, application/json, no-cache. */
export function checkRuntimeConfig(page: Page | string): Result {
  const check = 'runtime config';
  if (typeof page === 'string') return miss(check, page);
  const problems: string[] = [];
  if (page.status !== 200) problems.push(`status ${page.status}`);
  if ((page.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json')
    problems.push(`content-type ${JSON.stringify(page.headers['content-type'] ?? '')}`);
  if (page.headers['cache-control'] !== 'no-cache')
    problems.push(`cache-control ${JSON.stringify(page.headers['cache-control'] ?? '')}`);
  if (page.body.trim() !== RUNTIME_CONFIG_BODY) problems.push('the body is not {"audience":"public"}');
  return problems.length === 0
    ? pass(check, `200, no-cache, ${RUNTIME_CONFIG_BODY}`)
    : miss(check, problems.join('; '));
}

// ---------------------------------------------------------------- network

type Net = { resolve?: string; ca?: Buffer };
/** `bytes` is the body as received (a gzip download cannot go through the utf8 `body`). */
export type Page = { status: number; headers: Record<string, string | undefined>; body: string; bytes?: Buffer };

function lookupFor(net: Net): LookupFunction | undefined {
  if (net.resolve === undefined) return undefined;
  const address = net.resolve;
  const family = isIP(address);
  return ((_host: string, options: { all?: boolean }, cb: (...a: unknown[]) => void) =>
    options.all ? cb(null, [{ address, family }]) : cb(null, address, family)) as unknown as LookupFunction;
}

function get(
  url: string,
  net: Net,
  headers: Readonly<Record<string, string>> = {},
  method: 'GET' | 'HEAD' = 'GET',
): Promise<Page> {
  const u = new URL(url);
  const request = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      u,
      {
        method,
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
          const bytes = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers, body: bytes.toString('utf8'), bytes });
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
const tryGet = (
  url: string,
  net: Net,
  headers?: Readonly<Record<string, string>>,
  method?: 'GET' | 'HEAD',
): Promise<Page | string> =>
  get(url, net, headers, method).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));

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
  ...['FR-1', 'CH-1', 'DE-7', 'LU-1'].flatMap((id) => [
    `health ${id}: /api/v1/health/sources lists ${id} with status ok`,
    `tier-1 ${id}: >= 95% of the tier-1 series are fresh, each against its own limit (provider-stale ones are named and never make it a PASS)`,
    `coverage ${id}: coverage.ratio >= ${COVERAGE_MIN * 100}% (the expected buckets of the tier-1 series that hold a value since the seed; the series below 95%, the first instant and the gaps are listed; null is a FAIL; a tier-1 series that never had data is not in the coverage: tier-1 ${id} catches it)`,
  ]),
  `interval CH-1: the min_interval_s of ${INTERVAL_SPEC} is >= ${INTERVAL_MIN_S} s (BAFU: at most one download per 10 minutes, less 5 s for the scheduling jitter of a fetch start); no entry yet is a FAIL. The gap is per spec and variant: river and lake are two LINDAS downloads seconds apart every 10 minutes (whether BAFU counts them as one is asked in C13), and a recorder restart can run a catch-up under 10 minutes before the next tick, so this can FAIL for up to 24 h after a restart without a breach (KG-125)`,
  `interval DE-7: the min_interval_s of ${DE7_SPEC} is >= ${DE7_INTERVAL_MIN_S} s (every 15 minutes, less 5 s for the scheduling jitter of a fetch start); the detail prints the seconds, 3600 while the spec is hourly and about 900 once it runs every 15 minutes; no entry yet is a FAIL`,
  `bytes DE-7: the days of /status/capture.json (today, partial, and the two before) each hold at most ${DE7_BYTES_MAX / 1e6} MB of zstd bytes stored for ${DE7_SPEC}; the spec missing from capture.json, or no bytes in any day, is a FAIL`,
  `owner sources: /api/v1/health/sources (the contract document, max-age=30) counts at least ${OWNER_SOURCES_MIN} owner sources (owner_sources.total, which the registry sync writes, captured or not) and lists no owner-audience source of registry/sources.yaml in sources[]; the detail holds counts only`,
  'owner health: /api/v1/health/sources has owner_sources.healthy = owner_sources.total (needs live owner capture; the detail holds counts only)',
  `api meta: GET /api/v1/meta is 200 with Cache-Control exactly "${META_CACHE}", the Meta contract document, and ${API_SOURCES.join(', ')} among the sources`,
  'api build: /api/v1/meta build is the 40-hex release commit, not "dev" (KG-109: the image carries RWS_BUILD)',
  `api stations: GET /api/v1/stations is 200 with Cache-Control exactly "${STATIONS_CACHE}", the Stations contract document, a station with a series of each of ${API_SOURCES.join(', ')}`,
  `owner stations: /api/v1/stations lists no owner-audience station row of registry/stations/*.yaml and no id under ${OWNER_STATION_PREFIXES.join(' or ')} (the BE-3 and LU-2 owner station-id prefixes); the detail holds the count of stations checked`,
  ...SNAPSHOT_ASKS.map(
    (a) =>
      `api snapshot ${a.name}: GET /api/v1/snapshot?t= at the 10-minute floor of the server's own now${a.back === 0 ? '' : ` - ${a.name}`} (from /meta, never this clock) is 200, the Snapshot contract with t as asked, Cache-Control exactly "${a.cache}"`,
  ),
  'api states: every value of the "now" snapshot has a state; basis is null exactly for no_ref; section only with an area basis and no area beside it; nap and zero never both (counts only; no values is a PASS)',
  'class coverage: /api/v1/health/sources has a non-null classification (tier-1 ratio, how many are classed by a section only, mode, classed/stations per country; no stations is a PASS)',
  `forecast NL-1: /api/v1/health/sources lists NL-1 with a forecast whose newest run was issued at most ${FORECAST_NL1_MAX_AGE_S / 3600} h ago (RWS issues one run a day: the criterion is 30 h, owner decision 2026-10-03) and of whose series at least ${FORECAST_NL1_CURRENT_MIN * 100}% have a current run; needs live capture (numbers only)`,
  `forecast CH-4: /api/v1/health/sources lists CH-4 with a forecast whose newest run was issued at most ${FORECAST_CH4_MAX_AGE_S / 3600} h ago (BAFU starts a run every 2 to 6 hours, the capture is hourly) and that has a run on at least as many series as the registry expects (the seeded stations with a primary, non-off CH-1 series, less the ${CH4_NO_FORECAST.length} whose q_forecast answers 404); needs live capture (numbers only)`,
  'forecast coverage: /api/v1/health/sources has a non-null forecast_coverage with one entry per reach row of registry/forecast-reaches.yaml in order, each reach without a visible source states after_permission or none_publishes, and no owner-audience source ID or BfG appears in it (needs no fresh data; counts only)',
  `api openapi: GET /api/v1/openapi.json is 200 with Cache-Control exactly "${OPENAPI_CACHE}" and openapi 3.1.0`,
  'api params: GET /api/v1/meta?x=1 is 400 {"error":"unknown_parameter"} with Cache-Control: no-store',
  `noindex: ${NOINDEX_PATHS.join(', ')} each answer (the 404s of /api and /tiles too) with X-Robots-Tag: noindex`,
  ...['DE-1', 'NL-1', 'FR-1', 'CH-1', 'DE-7', 'LU-1'].map(
    (id) =>
      `fresh ${id}: in the "now" snapshot at least one ${id} series has a value no older than ${freshLimit(id)} s at the server's own now (/meta)`,
  ),
  "label offset LU-1: /api/v1/health/sources lists LU-1 with a label_offset whose latest measured UTC day, decided or not, is no older than 2 days before the server's own now (/meta); any offset passes, the detail prints that day (decided, its instants and share; or undecided), and the offset in force in minutes (15 is the AGE file's habit) with the day that decided it; none measured yet is a FAIL",
  `belgian set: the 25 points of catalogue §0.6 (the NL-1 locations ${BELGIAN_NL1.join(', ')} as nl.rws.<code>, the 18 FR-1 partners of registry/seed/fr-1-be.csv as fr.sandre.<code>) are all stations of /api/v1/stations, and >= ${BELGIAN_FRESH_PCT}% have a value in the "now" snapshot no older than ${BELGIAN_MAX_AGE_S / 3600} h at the server's own now`,
  `tiles manifest: GET /tiles/manifest.json is 200 with Cache-Control exactly "${MANIFEST_CACHE}" (never immutable) and a body parseTilesManifest accepts`,
  `tiles <file>: every file the manifest lists (current and previous), GET with Range: ${TILE_HEADERS.range} and Accept-Encoding: ${TILE_HEADERS['accept-encoding']}, is 206 with Content-Range bytes 0-15/<manifest bytes>, Cache-Control exactly "${TILE_CACHE}", no Content-Encoding and the PMTiles v3 magic first`,
  'tiles previous: n/a while the manifest has no previous extract (run the job again on a later build); a pass once it lists one',
  `tiles 404: ${TILES_404_PATHS.join(', ')} are 404 and none is marked immutable`,
  `tiles 416: GET on the current basemap file without Range, and with Range: ${TILE_416_REQUESTS[1][1].range}, is 416 and not immutable (only one explicit range is served)`,
  `map assets: GET ${MAP_ASSET_PATH} (a pinned glyph range of the web image) is 200 with Cache-Control exactly "${TILE_CACHE}"`,
  `rivers manifest: GET ${RIVERS_MANIFEST_PATH} is 200 with Cache-Control exactly "${MANIFEST_CACHE}" and a body the strict RiversManifest contract accepts`,
  `rivers tiles: GET /tiles/<the manifest's tiles file> with Range: ${TILE_HEADERS.range} is 206 with Content-Range bytes 0-15/<manifest bytes>, Cache-Control exactly "${TILE_CACHE}", no Content-Encoding and the PMTiles v3 magic first`,
  `rivers reaches: GET /data/v1/rivers/<the manifest's reaches file> is 200 JSON with Cache-Control exactly "${TILE_CACHE}", the ReachesFile contract, checkReaches clean, the manifest's version, and every station of it a station of /api/v1/stations (the file's body is also in owner leak)`,
  `rivers download: HEAD /downloads/<the manifest's download file> is 200 application/gzip with no Content-Encoding, ${TILE_CACHE} and the manifest's length; a Range of ${RIVERS_DOWNLOAD_RANGE}, gunzipped (truncation tolerated), shows "attribution": "${OSM_ATTRIBUTION}" and "licence": "${ODBL_LICENCE}" before "features"`,
  'rivers attribution: the entry script that / references contains the string ODbL (the footer text, P6b)',
  `static meta: GET /data/v1/meta.json is 200 application/json with Cache-Control exactly "${STATIC_CACHE.live}", the StaticMeta contract, ${API_SOURCES.join(', ')} among the sources, and no owner term in the body`,
  `static latest: GET /data/v1/latest.json is 200 with "${STATIC_CACHE.live}", the LatestFile contract and the seriesHash of stations.json`,
  `static stations: GET /data/v1/stations.json is 200 with "${STATIC_CACHE.slow}" and the StaticStations contract`,
  `static sources: GET /data/v1/sources.json is 200 with "${STATIC_CACHE.slow}" and the public StaticSources contract (no owner source ID, term or private_basis)`,
  `static recent: the recent file of the current or the previous 10-minute bucket of meta.now is 200 with "${STATIC_CACHE.recent}" and the SnapshotFile contract at that t`,
  `static settled: a sample of the newest settled day (version from meta.dayVersions, default 1) is 200 with "${STATIC_CACHE.immutable}" and the SnapshotFile contract; none yet (PASS) while version 0, before the display window or while the day is pending`,
  `static frames: frames/recent.json is 200 with "${STATIC_CACHE.slow}" and the FramesFile contract, and the newest settled day's frames file with "${STATIC_CACHE.immutable}" (none yet for that part is a PASS)`,
  `static forecast: GET /data/v1/forecast/latest.json is 200 with "${STATIC_CACHE.slow}" and the StaticForecastLatest contract`,
  `static series: the first station of stations.json has series/<id>/recent.json, 200 with "${STATIC_CACHE.slow}" and the StationRecent contract`,
  `static warnings: warnings/latest.geojson is 200 ${GEOJSON} with "${STATIC_CACHE.warnings}" and the WarningsFile contract; yesterday's dated file, when it exists, with "${STATIC_CACHE.immutable}"`,
  `static status: GET /data/v1/status.json is 200 with "${STATIC_CACHE.status}", the public StatusFile contract (public sources, the two ownerSources counts) and no owner term`,
  'static precompressed: meta.json with Accept-Encoding zstd and with gzip: that Content-Encoding, Vary: Accept-Encoding and a decompressed body equal to the identity body',
  `static lag: health.loader.last_commit minus meta.latestFrom is at most ${STATIC_LAG_MAX_S} s (no loader commit yet is a PASS)`,
  `static rerender: status.publisher.lastDayRender.seconds is under ${RERENDER_MAX_S} s (C23; none rendered yet is a PASS)`,
  `runtime config: GET /runtime-config.json is 200 application/json, Cache-Control no-cache, exactly ${RUNTIME_CONFIG_BODY}`,
  `owner leak: no owner source ID, spec ID, host, canary (${CANARY_RENDERINGS.join(', ')}) or private_basis key in any /status/* body or /api/v1/health, health/sources, meta, stations and snapshot body, the rivers manifest and the reaches file, and (P9a) every public /data/v1 file fetched by the static checks`,
  'owner ids: no owner-audience source ID of registry/sources.yaml as a whole word in a string value or object key of /api/v1/health or health/sources',
  `interval DE-6: (--interval, slow: ${DE6_SAMPLES} samples of /status/capture.json ${DE6_GAP_MS / 60_000} min apart, about 30 min) ${DE6_SPECS.join(' and ')} have a last_success at most ${DE6_MAX_AGE_S} s before that sample's generated_at in every sample (a missing spec or null last_success is a FAIL) and it advanced; without the flag the check is N/A (skipped)`,
  '--soak: >= 99% ok per source (5xx and timeouts listed), seed coverage, byte baseline, drill 100/100',
  ...TWIN_IDS.map(
    (id) =>
      `twin ${id}: (--soak) listed in /api/v1/health/sources (a pair with no check yet is a FAIL); latest check under ${TWIN_MAX_AGE_MS / 3_600_000} h old, ok, with aligned timestamps and a lag of 0; no failed check in 7 days; >= ${TWIN_MIN_CHECKS_7D} of the 168 hourly checks`,
  ),
  '--capacity: bytes/day per spec over >= 2 complete days, the year-1 projection vs the disk and the bucket',
];

function usage(): never {
  console.error(
    'usage: scripts/verify-prod.sh <domain> [--soak | --capacity [--owner-bytes-per-day N] [--out FILE]] [--interval] [--dry-run]',
  );
  process.exit(64);
}

const pageBody = (page: Page | string | undefined) => (typeof page === 'object' ? page.body : '');

async function main(argv: string[]): Promise<number> {
  const net: Net = {};
  let domain = '';
  let mode: 'default' | 'soak' | 'capacity' = 'default';
  let dry = false;
  let interval = false;
  let out: string | undefined;
  let ownerBytes: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i] ?? usage();
    if (a === '--soak') mode = 'soak';
    else if (a === '--capacity') mode = 'capacity';
    else if (a === '--dry-run') dry = true;
    else if (a === '--interval') interval = true;
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
    if (cap?.success) results.push(...checkCapture(cap.data, now), checkBytes(cap.data));

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
      ...(['FR-1', 'CH-1', 'DE-7', 'LU-1'] as const).flatMap((id) => [
        checkSourceHealth(sources, id),
        checkTier1(sources.data, id),
        checkCoverage(sources.data, id),
      ]),
      checkInterval(sources.data),
      checkInterval(sources.data, 'DE-7'),
      checkOwnerSources(sources, ownerSourceIds(registry)),
      checkOwnerHealth(sources),
      checkOwnerIds(
        { [HEALTH_PATHS[0]]: pageBody(healthPage), [HEALTH_PATHS[1]]: pageBody(sourcesPage) },
        ownerSourceIds(registry),
      ),
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
      checkOwnerStations(stationsRead, new Set(ownerStationIds(readRegistry().stations))),
      ...SNAPSHOT_ASKS.map((ask) => checkSnapshot(ask, snapReads.get(ask.name))),
      checkStates(snapReads.get('now')?.data),
      checkClassCoverage(sources.data),
      checkForecastNl1(sources.data),
      checkForecastCh4(sources.data),
      checkForecastCoverage(sources.data, ownerSourceIds(registry)),
      checkOpenapi(readApi(await api('/api/v1/openapi.json'), OpenApi31, OPENAPI_CACHE)),
      checkApiParams(await api('/api/v1/meta?x=1')),
      checkNoindex(noindex),
      checkFresh('DE-1', snapReads.get('now')?.data, stationsRead.data, metaRead.data?.now),
      ...(['NL-1', 'FR-1', 'CH-1', 'DE-7', 'LU-1'] as const).map((id) =>
        checkFresh(id, snapReads.get('now')?.data, stationsRead.data, metaRead.data?.now),
      ),
      checkLabelOffset(sources.data, metaRead.data?.now),
      checkBelgianSet(belgianIds(), stationsRead.data, snapReads.get('now')?.data, metaRead.data?.now),
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

    // P6b: the rivers (A§9.1). The names come from the manifest only; the leak grep below reads their bodies too.
    const riversPage = await tile(RIVERS_MANIFEST_PATH);
    const rivers = readRiversManifest(riversPage);
    const cur = rivers.manifest?.current;
    const reachesPage = cur === undefined ? undefined : await tile(`/data/v1/rivers/${cur.reaches.file}`);
    const downloadPath = cur === undefined ? undefined : `/downloads/${cur.download.file}`;
    const stationIds =
      stationsRead.data === undefined ? undefined : new Set(stationsRead.data.stations.map((st) => st.id));
    const entry = entryScript(
      await tryGet(`https://${domain}/`, net).then((p) => (typeof p === 'string' ? '' : p.body)),
    );
    results.push(
      checkRiversManifest(rivers),
      checkRiversTiles(
        rivers.manifest,
        cur === undefined ? undefined : await tile(`/tiles/${cur.tiles.file}`, TILE_HEADERS),
      ),
      checkRiversReaches(rivers.manifest, reachesPage, stationIds),
      checkRiversDownload(
        rivers.manifest,
        downloadPath === undefined
          ? undefined
          : await tryGet(`https://${domain}${downloadPath}`, net, RIVERS_DOWNLOAD_HEADERS, 'HEAD'),
        downloadPath === undefined
          ? undefined
          : await tile(downloadPath, { ...RIVERS_DOWNLOAD_HEADERS, range: RIVERS_DOWNLOAD_RANGE }),
      ),
      checkRiversAttribution(entry === undefined ? undefined : await tile(entry)),
    );

    // P9a: the static publisher's files through Caddy. The terms are checked per file (readStatic) and in the sweep below.
    const terms = leakTerms(registry);
    const st = (path: string, headers?: Readonly<Record<string, string>>) =>
      tryGet(`https://${domain}${path}`, net, headers);
    const D = '/data/v1/';
    const staticPages: Record<string, Page | string> = {};
    const fetchStatic = async (path: string) => (staticPages[`${D}${path}`] = await st(`${D}${path}`));
    const smeta = readStatic(await fetchStatic('meta.json'), StaticMeta, STATIC_CACHE.live, undefined, terms);
    const slatest = readStatic(await fetchStatic('latest.json'), LatestFile, STATIC_CACHE.live, undefined, terms);
    const sstations = readStatic(
      await fetchStatic('stations.json'),
      StaticStations,
      STATIC_CACHE.slow,
      undefined,
      terms,
    );
    const ssources = readStatic(await fetchStatic('sources.json'), StaticSources, STATIC_CACHE.slow, undefined, terms);
    let srecent: ApiRead<SnapshotFile> | undefined;
    let srecentT: number | undefined;
    for (const c of recentCandidates(smeta.data?.now)) {
      srecent = readStatic(await fetchStatic(c.path), SnapshotFile, STATIC_CACHE.recent, undefined, terms);
      srecentT = c.ms;
      if (srecent.data !== undefined) break;
    }
    const sstatus = readStatic(await fetchStatic('status.json'), StatusFile, STATIC_CACHE.status, undefined, terms);
    const ask = settledAsk(smeta.data, sstatus.data?.publisher.pendingDays);
    const settledPage = ask === undefined ? undefined : await fetchStatic(settledPath(ask.t, ask.version));
    const framesRecent = readStatic(
      await fetchStatic('frames/recent.json'),
      FramesFile,
      STATIC_CACHE.slow,
      undefined,
      terms,
    );
    const framesSettled = ask === undefined ? undefined : await fetchStatic(framesPath(ask.day, ask.version));
    const firstStation = sstations.data?.stations[0]?.id;
    const sseries =
      firstStation === undefined
        ? undefined
        : readStatic(
            await fetchStatic(`series/${firstStation}/recent.json`),
            StationRecent,
            STATIC_CACHE.slow,
            undefined,
            terms,
          );
    const sforecast = readStatic(
      await fetchStatic('forecast/latest.json'),
      StaticForecastLatest,
      STATIC_CACHE.slow,
      undefined,
      terms,
    );
    const swarn = readStatic(
      await fetchStatic('warnings/latest.geojson'),
      WarningsFile,
      STATIC_CACHE.warnings,
      GEOJSON,
      terms,
    );
    const yday = dayOf(Date.parse(smeta.data?.now ?? now.toISOString()) - DAY_MS);
    const ydayPage = await fetchStatic(`warnings/${yday}.json`);
    const idPage = await st(`${D}meta.json`);
    const zstdPage = await st(`${D}meta.json`, { 'accept-encoding': 'zstd' });
    const gzipPage = await st(`${D}meta.json`, { 'accept-encoding': 'gzip' });
    results.push(
      checkStaticMeta(smeta),
      checkStaticLatest(slatest, sstations.data),
      checkStaticStations(sstations),
      checkStaticSources(ssources),
      checkStaticRecent(srecent, srecentT),
      checkStaticSettled(ask, settledPage),
      checkStaticFrames(framesRecent, ask, framesSettled),
      checkStaticForecast(sforecast),
      checkStaticSeries(sseries, firstStation),
      checkStaticWarnings(swarn, { day: yday, page: ydayPage }),
      checkStaticStatus(sstatus),
      checkStaticPrecompressed(idPage, { zstd: zstdPage, gzip: gzipPage }),
      checkStaticLag(health.data, smeta.data),
      checkStaticRerender(sstatus),
      checkRuntimeConfig(await st('/runtime-config.json')),
    );

    const body = pageBody;
    results.push(
      checkOwnerLeak(
        {
          '/status/*': `${capture.page?.body ?? ''}\n${ops.page?.body ?? ''}`,
          [HEALTH_PATHS[0]]: body(healthPage),
          [HEALTH_PATHS[1]]: body(sourcesPage),
          '/api/v1/meta': body(metaPage),
          '/api/v1/stations': body(stationsPage),
          [RIVERS_MANIFEST_PATH]: body(riversPage),
          '/data/v1/rivers/reaches': body(reachesPage),
          ...Object.fromEntries(Object.entries(staticPages).map(([path, page]) => [path, body(page)])),
          ...Object.fromEntries(
            SNAPSHOT_ASKS.map((ask) => [`/api/v1/snapshot ${ask.name}`, body(snapPages[ask.name])]),
          ),
        },
        leakTerms(registry),
      ),
    );
    results.push(
      interval
        ? checkIntervalDe6(
            await sampleCapture(
              async () => {
                const f = await statusFile(domain, 'capture.json', net);
                const p = f.page && CaptureStatus.safeParse(parseJson(f.page.body));
                return p?.success ? p.data : undefined;
              },
              (ms) => new Promise((r) => setTimeout(r, ms)),
            ),
          )
        : { check: 'interval DE-6', ok: 'n/a', detail: 'skipped: slow (about 30 min); pass --interval' },
    );
  } else if (mode === 'soak') {
    if (cap?.success && opsDoc?.success) {
      const s = soak(cap.data, opsDoc.data);
      results.push(...s.results);
      console.log(s.report.join('\n'));
    }
    const twinSources = readApi(await tryGet(`https://${domain}${HEALTH_PATHS[1]}`, net), HealthSources);
    for (const id of TWIN_IDS) results.push(checkTwin(twinSources, now, id));
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
