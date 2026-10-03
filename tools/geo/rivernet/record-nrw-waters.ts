import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { captureEnv, captureUserAgent, EXIT_CONFIG } from '../../../apps/server/src/capture/env.ts';
import { parseJsonArray } from '../../../packages/core/src/json.ts';
import { ROOT, readSources } from './sources.ts';

// Opt-in recorder (P6b): the published water body (`WTO_OBJECT`) of the registered DE-7 stations, from LANUK's
// station list (registry/geo-sources.yaml `nrw_stations`). Exactly one GET, never in CI. Writes
// registry/seed/de-7-waters.csv, which scripts/gen-de7-stations.ts reads.
//
//   RWS_DOMAIN=… RWS_CONTACT_EMAIL=… node tools/geo/rivernet/record-nrw-waters.ts [--save <dir>]
//   … node tools/geo/rivernet/record-nrw-waters.ts --from <dir>/stations.json    # offline, from a saved body

export const OUTPUT = join(ROOT, 'registry/seed/de-7-waters.csv');
const DE7_REGISTRY = join(ROOT, 'registry/stations/de-7.yaml');
const TIMEOUT_MS = 60_000;
const CAPS = { maxNodes: 2_000_000, maxDepth: 6, maxItems: 5000 };
/** The WSV (federal waterways) site number: those gauges are DE-1's, never DE-7's. */
const WSV = '102';

/** The only error of this module: a fixed code, never provider text. */
export class WatersError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'WatersError';
    this.code = code;
  }
}

// An empty string is the file's "no water body" (most stations); anything else is trimmed text.
const Water = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .max(200)
      .refine((s) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s)),
  );
// Other keys are ignored (the file has many); the three that are read are strict.
const Row = z.looseObject({
  station_no: z.string().regex(/^[0-9]{1,20}$/),
  site_no: z.string().max(20),
  WTO_OBJECT: Water.optional(),
});
export type NrwStation = { station_no: string; site_no: string; water: string | null };

/** The station list: bounded, strict on the three fields read. Throws only WatersError. */
export function parseNrwStations(text: string): NrwStation[] {
  try {
    return parseJsonArray(text, Row, CAPS).map((r) => ({
      station_no: r.station_no,
      site_no: r.site_no,
      water: r.WTO_OBJECT === undefined || r.WTO_OBJECT === '' ? null : r.WTO_OBJECT,
    }));
  } catch {
    throw new WatersError('schema_drift');
  }
}

/** The rows kept: registered numbers, not WSV, with a water; sorted by number. One number, two waters: an error. */
export function selectWaters(rows: readonly NrwStation[], registered: ReadonlySet<string>): [string, string][] {
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!registered.has(r.station_no) || r.site_no === WSV || r.water === null) continue;
    const had = out.get(r.station_no);
    if (had !== undefined && had !== r.water) throw new WatersError('conflicting_water');
    out.set(r.station_no, r.water);
  }
  return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function toCsv(
  waters: readonly [string, string][],
  meta: { url: string; date: string; sha256: string },
): string {
  if (waters.some(([, w]) => w.includes(';'))) throw new WatersError('bad_water');
  return [
    '# DE-7 water bodies: `WTO_OBJECT` (the published water body) per registered DE-7 station.',
    `# source ${meta.url}, retrieved ${meta.date} (UTC), body sha256 ${meta.sha256}`,
    '# rule: the stations whose station_no is a DE-7 provider_code of registry/stations/de-7.yaml and whose site_no is not 102',
    '# (WSV), with a WTO_OBJECT (trimmed, 1-200 characters); one number with two different waters is an error.',
    '# Written by tools/geo/rivernet/record-nrw-waters.ts; scripts/gen-de7-stations.ts reads it. Provider text is data.',
    'station_no;water',
    ...waters.map(([no, w]) => `${no};${w}`),
    '',
  ].join('\n');
}

export function registeredDe7(path = DE7_REGISTRY): Set<string> {
  const doc = parseYaml(readFileSync(path, 'utf8')) as { stations: { provider_code: string }[] };
  return new Set(doc.stations.map((s) => s.provider_code));
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (!res.body) throw new WatersError('no_body');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      reader.cancel().catch(() => {});
      throw new WatersError('body_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The CLI; returns the exit code (0 ok, 1 failure, 64 usage or CI, 78 without RWS_DOMAIN/RWS_CONTACT_EMAIL). */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch = fetch,
  log: (s: string) => void = console.log,
  now: () => Date = () => new Date(),
): Promise<number> {
  if (env.CI) {
    log('refused: opt-in tool, not for CI');
    return 64;
  }
  let save: string | undefined;
  let from: string | undefined;
  if (argv.length === 2 && argv[0] === '--save') save = argv[1];
  else if (argv.length === 2 && argv[0] === '--from') from = argv[1];
  else if (argv.length !== 0) {
    log('usage: [--save <dir> | --from <saved stations.json>]');
    return 64;
  }
  const ce = captureEnv(env);
  if (typeof ce === 'string') {
    log(ce);
    return EXIT_CONFIG;
  }
  try {
    const { url, max_bytes } = readSources().nrw_stations;
    const registered = registeredDe7();
    let body: Buffer;
    if (from) body = readFileSync(from);
    else {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { accept: 'application/json', 'user-agent': captureUserAgent(ce) },
        });
      } catch {
        throw new WatersError('fetch_failed');
      }
      if (res.status !== 200) {
        res.body?.cancel().catch(() => {});
        throw new WatersError('http_status');
      }
      body = await readCapped(res, max_bytes);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      throw new WatersError('bad_utf8');
    }
    if (save) {
      mkdirSync(save, { recursive: true });
      writeFileSync(join(save, 'stations.json'), body);
    }
    const waters = selectWaters(parseNrwStations(text), registered);
    const sha256 = createHash('sha256').update(body).digest('hex');
    writeFileSync(OUTPUT, toCsv(waters, { url, date: now().toISOString().slice(0, 10), sha256 }));
    log(
      `wrote ${OUTPUT}: ${waters.length} of ${registered.size} registered stations, ${body.length} bytes, sha256 ${sha256}`,
    );
    return 0;
  } catch (e) {
    log(`error: ${e instanceof WatersError ? e.code : 'internal'}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2), process.env);
