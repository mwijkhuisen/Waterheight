// CI only (P12a, issue #27): writes the routes and the bodies of the fake upstream (server.mjs).
//
//   node deploy/tests/e2e/fake-upstream/prepare.ts <out dir>      (setup.sh runs it in the build image, no network)
//
// Output: <out>/routes.json and <out>/bodies/<spec>.raw. The routes come from the registry (the host, path and query
// of the spec's own request, as capture builds it), the bodies are the repository's recorded payloads
// (`recorded()` of scripts/fixture-archive.ts): the same bytes the end-to-end archive already holds, so a capture
// cycle against the fake loads nothing the stack does not know.
//
// The spec set is narrow and public-audience only (never an owner source; invariant 11), from four providers:
//   DE-1 de-1-basin, de-1-meta   every 15 minutes / once at the first start (the group's other spec, de-1-series,
//                                has a variant per gauge: not faked)
//   CH-2 ch-2-pq                 every 10 minutes
//   LU-1 lu-1-csv                every 15 minutes
//   NL-2 nl-2-wfs                every 10 minutes (the CQL_FILTER of its request varies: a query prefix)
// Deliberately not faked: DE-6, FR-5, LU-5, CH-4 (the sources of the flood drill, which writes their archive lines
// itself; a capture line from here would overwrite what the drill states) and every owner source.
//
// Why `lag_p95` is not null: the loader calls its lag sample for every manifest line it consumes (a stored payload,
// a dup_of line, a 304, a failed fetch), and a sample counts when the line was fetched in the last hour. The fake
// answers 200 with a valid body every cycle, so each cycle of each spec yields a line within seconds of its fetch.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '../../../../apps/server/src/archive/validity.ts';
import { requestFor } from '../../../../apps/server/src/capture/adapters.ts';
import { baseRequest, loadRegistry } from '../../../../apps/server/src/capture/specs.ts';
import { recorded } from '../../../../scripts/fixture-archive.ts';

/** Spec id -> the source folder and recorded fixture its body comes from. */
export const FAKED: Readonly<Record<string, { source: string; fixture: string }>> = {
  'de-1-basin': { source: 'DE-1', fixture: 'de-1-basin' },
  'de-1-meta': { source: 'DE-1', fixture: 'de-1-meta' },
  'ch-2-pq': { source: 'CH-2', fixture: 'ch-2-pq' },
  'lu-1-csv': { source: 'LU-1', fixture: 'lu-1-csv' },
  'nl-2-wfs': { source: 'NL-2', fixture: 'nl-2-wfs' },
};

const TYPES: Record<string, string> = { json: 'application/json', csv: 'text/csv' };

export type Route = {
  spec: string;
  host: string;
  path: string;
  query?: string;
  query_prefix?: string;
  status: number;
  headers: Record<string, string>;
  body: string;
};

export async function build(): Promise<{ routes: Route[]; bodies: Map<string, Buffer> }> {
  const registry = loadRegistry();
  const now = new Date();
  const routes: Route[] = [];
  const bodies = new Map<string, Buffer>();
  for (const [id, { source, fixture }] of Object.entries(FAKED)) {
    const spec = registry.specs.find((s) => s.id === id);
    const row = spec?.rows[0];
    if (spec === undefined || row === undefined) throw new Error(`fake upstream: no spec ${id}`);
    if (spec.audience !== 'public' || spec.source !== source)
      throw new Error(`fake upstream: ${id} is not public ${source}`);
    const body = recorded(fixture, source).body;
    const v = await validate(spec.validity, 200, body);
    if (!v.ok) throw new Error(`fake upstream: the recorded ${fixture} fails the validity of ${id} (${v.reason})`);
    const sent = new URL(requestFor(spec, row, now).url);
    const base = new URL(baseRequest(spec, row).url);
    const query = sent.search.slice(1);
    // A request an adapter extends (NL-2's CQL_FILTER): match on what the registry fixes.
    const prefix = base.search.slice(1);
    routes.push({
      spec: id,
      host: sent.hostname,
      path: sent.pathname,
      ...(query === prefix ? { query } : { query_prefix: `${prefix}&` }),
      status: 200,
      headers: { 'content-type': TYPES[spec.validity.format] ?? 'application/octet-stream' },
      body: `${id}.raw`,
    });
    bodies.set(`${id}.raw`, body);
  }
  return { routes, bodies };
}

if (import.meta.main) {
  const out = process.argv[2];
  if (out === undefined || process.argv.length !== 3) {
    console.error('usage: node prepare.ts <out dir>');
    process.exit(64);
  }
  const { routes, bodies } = await build();
  mkdirSync(join(out, 'bodies'), { recursive: true });
  for (const [name, body] of bodies) writeFileSync(join(out, 'bodies', name), body);
  writeFileSync(join(out, 'routes.json'), `${JSON.stringify(routes, null, 2)}\n`);
  console.log(`fake upstream: ${routes.length} routes on ${[...new Set(routes.map((r) => r.host))].join(' ')}`);
}
