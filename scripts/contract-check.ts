// Nightly live contract check (issue #17; A§7.1; PHASES P2b, P5a): one payload each of DE-1, NL-1,
// NL-2, FR-1, CH-1 and CH-2 is fetched live and run through the exact code the loader uses
// (validity, strict parse, normalise). A provider that changed its format or moved its host (the
// RWS CTD switch on 2026-11-05) turns the night red; .github/workflows/contract-check.yml files
// the issue.
//
//   RWS_DOMAIN=… RWS_CONTACT_EMAIL=… node scripts/contract-check.ts [--out <file>]
//
// Targets come only from registry/capture.yaml (invariant 1): no argument names a URL or a host.
// Six requests at most (one per spec, the first row of each; FR-1 only its first page, never `next`),
// one after the other, through the SSRF-guarded client with the contact User-Agent and no secret
// header (no RWS API key ever leaves CI). It does not refuse under CI. BAFU asks LINDAS users for
// at most one download per 10 minutes: the workflow runs at 03:29, midway between the recorder's
// CH-1 fetches (minutes 4, 14, 24, 34, …), so ours never comes within 5 minutes of one.
//
// stdout and --out: one line per spec, `<spec> <code>`, nothing else (LINE_SOURCE). The code is a
// fixed identifier of ours; no URL, header, User-Agent, e-mail or byte of a provider payload ever
// reaches it, because the workflow's report job files this text in a public issue.
// Exit: 0 all ok, 1 drift, 64 usage, 78 the contact variables are missing or malformed.
import { writeFileSync } from 'node:fs';
import { validate } from '../apps/server/src/archive/validity.ts';
import { requestFor } from '../apps/server/src/capture/adapters.ts';
import { captureEnv, captureUserAgent, EXIT_CONFIG } from '../apps/server/src/capture/env.ts';
import { loadRegistry } from '../apps/server/src/capture/specs.ts';
import { Client, type FetchOptions, METADATA_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from '../apps/server/src/http/client.ts';
import type { FetchResult, Req } from '../apps/server/src/http/types.ts';
import { LOAD_ADAPTERS } from '../apps/server/src/load/adapters.ts';
import { RETAINED } from '../apps/server/src/load/pipeline.ts';
import { declarationsOf, readRegistry } from '../apps/server/src/load/registry-sync.ts';
import { SchemaDrift } from '../packages/core/src/errors.ts';

export const SPECS = ['de-1-basin', 'nl-1-obs-key', 'nl-2-wfs', 'fr-1-obs', 'ch-1-lindas', 'ch-2-pq'] as const;

export type Report = { at: string; results: { spec: string; code: string }[] };
export type Deps = {
  fetch: (source: string, req: Req, opts: FetchOptions) => Promise<FetchResult>;
  now: Date;
};

/**
 * A report line, in the subset that JavaScript and `grep -E -x` read alike (no `(?:`, no escape inside
 * a bracket expression). It has no backtick, `@`, `#`, `<`, `:`, `/` or second space: the report job
 * may put a line inside a code fence without escaping anything.
 */
export const LINE_SOURCE = '^[a-z0-9]+(-[a-z0-9]+)* [a-z0-9_]{1,40}( at ([A-Za-z0-9_.?-]|\\[|\\]){1,120})?$';
const LINE = new RegExp(LINE_SOURCE);
const SPEC_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CODE = /^[a-z0-9_]{1,40}$/;

/** `<prefix>_<reason>` when that is a fixed-looking code, else the fallback. */
const coded = (prefix: string, reason: unknown, fallback: string) => {
  const code = `${prefix}_${String(reason)}`;
  return CODE.test(code) ? code : fallback;
};

type Stations = ReturnType<typeof readRegistry>['stations'];

/** The one code of a spec: `ok` or what went wrong. Throws only on a bug or a registry that does not load. */
async function outcome(id: string, deps: Deps, capture: ReturnType<typeof loadRegistry>, stations: Stations) {
  const spec = capture.specs.find((s) => s.id === id);
  const row = spec?.rows[0];
  if (spec === undefined || row === undefined) return 'no_spec';
  const adapter = Object.hasOwn(LOAD_ADAPTERS, spec.source) ? LOAD_ADAPTERS[spec.source] : undefined;
  const loader = adapter !== undefined && Object.hasOwn(adapter.specs, id) ? adapter.specs[id] : undefined;
  // No loader: the list above is wrong. Nothing is fetched for it.
  if (loader === undefined) return 'no_adapter';

  const req = requestFor(spec, row, deps.now);
  const r = await deps.fetch(spec.source, req, {
    maxBytes: spec.max_bytes,
    timeoutMs: spec.timeout === 'metadata' ? METADATA_TIMEOUT_MS : TOTAL_TIMEOUT_MS,
  });
  if (!r.ok) return coded('fetch', r.error, 'fetch_failed');
  const { status, body } = r.res;
  // We send no validator, so a 304 is an anomaly, not "unchanged".
  if (status === 304) return 'http_304';
  const v = await validate(spec.validity, status, body);
  if (!v.ok) return v.reason === 'status' ? `http_${status}` : coded('invalid', v.reason, 'invalid');
  // Valid and empty is the RWS 204 "no data" (allow_status): nothing to parse.
  if (body.length === 0) return 'ok';
  if (body.length > loader.maxBytes) return 'too_large';

  const registry = declarationsOf(stations, spec.source);
  try {
    const out = loader.run(body, {
      registry,
      fetchedAt: deps.now.getTime(),
      variant: req.variant,
      unitMismatch: new Set(),
    });
    const withheld = RETAINED.find((code) => (out.dropped[code] ?? 0) > 0);
    if (withheld !== undefined) return withheld;
    // NL-1's first row (Lobith) is registered: an unknown series means the payload names it otherwise.
    if (spec.source === 'NL-1' && out.unknown > 0) return 'unknown_series';
    // Parsed, yet nothing came out of a source with registered series (every value a gap, stale or too old;
    // a renamed process type or compartment is registered_dropped above). NL-2 has none: it stores no observation.
    return registry.size > 0 && out.obs.length + out.gaugeZeros.length === 0 ? 'no_rows' : 'ok';
  } catch (err) {
    // SchemaDrift.message is `<code>` or `<code> at <sanitised path>`; the wire check below has the last word.
    return err instanceof SchemaDrift ? err.message : 'adapter_error';
  }
}

/** One request per spec, one after the other. Pure apart from `deps.fetch`; never carries a URL, header or provider text. */
export async function check(deps: Deps): Promise<Report> {
  const capture = loadRegistry();
  const { stations } = readRegistry();
  const results: Report['results'] = [];
  for (const spec of SPECS) {
    const code = await outcome(spec, deps, capture, stations).catch(() => 'check_error');
    results.push({ spec, code });
  }
  return { at: deps.now.toISOString(), results };
}

/** The wire format for the reporting job. A line that would not match LINE becomes `<spec> unreportable`. */
export function reportLines(report: Report): string {
  return report.results
    .map(({ spec, code }) => {
      const line = `${spec} ${code}`;
      return LINE.test(line) ? line : `${SPEC_ID.test(spec) ? spec : 'unknown'} unreportable`;
    })
    .join('\n');
}

async function main(argv: string[]): Promise<number> {
  const out = argv[0] === '--out' && argv.length === 2 ? argv[1] : undefined;
  if (argv.length > 0 && out === undefined) {
    console.error('usage: node scripts/contract-check.ts [--out <file>]');
    return 64;
  }
  const env = captureEnv(process.env);
  if (typeof env === 'string') {
    console.error(`contract-check: ${env}`);
    return EXIT_CONFIG;
  }
  const registry = loadRegistry();
  // No sourceHeaders: the optional RWS x-api-key is never sent from CI.
  const client = new Client({ hosts: registry.hosts, userAgent: captureUserAgent(env) });
  const report = await check({ fetch: (source, req, opts) => client.fetch(source, req, opts), now: new Date() });
  const lines = reportLines(report);
  const failed = report.results.filter((r) => r.code !== 'ok').length;
  console.error(`contract-check ${report.at}: ${failed} of ${report.results.length} specs failed`);
  console.log(lines);
  if (out !== undefined) writeFileSync(out, `${lines}\n`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
