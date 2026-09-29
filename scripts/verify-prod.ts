// Outside-in production check (issue #16 P1b build item 10; A§11.2 step 4;
// PHASES §2.1 [agent-prod]). No SSH: only what any visitor can fetch. Exits
// non-zero on any miss and prints one PASS/FAIL/N-A line per check.
//
//   scripts/verify-prod.sh <domain>              TLS (IPv4 and IPv6), the exact A§12.2
//                                                headers, noindex, /healthz, both status
//                                                files, per-spec freshness, owner_specs,
//                                                and no owner source, spec or host in /status/*
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

const root = join(import.meta.dirname, '..');
export const CERT_MIN_DAYS = 14;
export const OWNER_CANARY = '777777.777';
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
 * A spec with no success and no failure yet that is not overdue by more than
 * 3 × cadence_s: nothing to judge (after go-live, or a new spec), as the
 * contract's own freshness counts it from when it was enabled.
 */
const notRunYet = (s: StatusSpec, now: Date) =>
  s.last_success === null &&
  s.last_failure_status === null &&
  (s.next_due === null || now.getTime() - Date.parse(s.next_due) <= 3 * s.cadence_s * 1000);

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

// ---------------------------------------------------------------- network

type Net = { resolve?: string; ca?: Buffer };
type Page = { status: number; headers: Record<string, string | undefined>; body: string };

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

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const CHECKS = [
  'tls ipv4 / tls ipv6: a valid certificate for the domain on every A and AAAA address, >= 14 days left (IPv6 n/a without AAAA or route)',
  'headers / and /en/: 200 and every A§12.2 header byte for byte (CSP from ARCHITECTURE.md), X-Robots-Tag: noindex, no CORS, no Server',
  'healthz: GET /healthz answers 200',
  'http: http:// redirects to https://',
  'status capture.json / ops.json: 200, Cache-Control: no-store, the exact contract fields',
  'freshness: every public spec succeeded within 3 × cadence_s',
  'owner_specs: fresh = total',
  'owner leak: no owner source ID, spec ID, host or the owner canary in any /status/* body',
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
    const found = leaks(`${capture.page?.body ?? ''}\n${ops.page?.body ?? ''}`, ownerTerms(registry));
    results.push(
      found.length === 0
        ? pass('owner leak', `none of ${ownerTerms(registry).length} owner terms in /status/*`)
        : miss('owner leak', `found in /status/*: ${found.join(', ')}`),
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
