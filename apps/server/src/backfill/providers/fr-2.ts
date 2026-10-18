import { readFileSync } from 'node:fs';
import { SchemaDrift } from '@rws/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { parseElab } from '../../adapters/fr-2/parse.ts';
import type { Req } from '../../http/types.ts';
import { driftCode } from '../drift.ts';
import type { Provider } from '../provider.ts';
import type { BackfillSpecAny, Fr2BackfillSpec, Fr2Unit, LoadedBackfillSpec } from '../spec.ts';

// P14b: the FR-2 backfill provider (Hub'Eau obs_elab): units are the FR-1 aggregate twin series, one GET per series
// and chunk, no probe, 206 (a page with a `next`) or `count` above the page means truncated, and the chunk halves.
// Requests are built only from the registry row and the spec (invariant 1): the station code of a registry row, never
// a site code, and the dates of the chunk. Only types come from spec.ts, which imports PROVIDERS.

const StationRow = z.looseObject({
  provider_code: z.string(),
  provider_key: z.string(),
  role: z.string(),
  audience: z.string(),
  aggregate: z.enum(['mean', 'max', 'min']).optional(),
});
const StationsFile = z.looseObject({ stations: z.array(StationRow) });

const DAY_MS = 86_400_000;
/** The records of one answer: the API's own maximum, and the spec's chunk (P7300D) holds at most 7,300. */
const SIZE = 20_000;
/** A parse cap error means the answer outgrew what we read; any other drift is the parser's own. */
const CAP_CODES = new Set(['too_big', 'json_too_many_nodes', 'json_too_deep']);
/** The key of an aggregate row: a Sandre station code and the grandeur. */
const KEY = /^([A-Z][0-9A-Z]{9})\/(QmnJ|HIXnJ)$/;

const fr2Spec = (spec: BackfillSpecAny | LoadedBackfillSpec): Fr2BackfillSpec & { url: string } => {
  if (spec.source !== 'FR-2') throw new Error('backfill: the FR-2 provider got another source');
  return spec;
};

/**
 * The units of a spec: the FR-1 rows that carry an `aggregate` and a grandeur the spec selects, in registry order. A row
 * that is not a twin with a key `<code>/<grandeur>` of its own station, or not public like its source (review S8: the
 * ledger and `detail.backfill` count per source), is a registry fault.
 */
function units(spec: BackfillSpecAny, dir: URL): Fr2Unit[] {
  const { target, select } = fr2Spec(spec);
  const file = StationsFile.parse(
    parseYaml(readFileSync(new URL(`stations/${target.toLowerCase()}.yaml`, dir), 'utf8')),
  );
  const out: Fr2Unit[] = [];
  for (const r of file.stations) {
    if (r.aggregate === undefined) continue;
    const m = KEY.exec(r.provider_key);
    if (m === null || m[1] !== r.provider_code || r.role !== 'twin')
      throw new Error(`registry/stations: ${r.provider_key} is not an aggregate twin key of ${r.provider_code}`);
    const grandeur = m[2] as 'QmnJ' | 'HIXnJ';
    if (!select.aggregates.includes(grandeur)) continue;
    if (r.audience !== 'public')
      throw new Error(`registry/stations: ${r.provider_key} is not public like its source; a backfill selects none`);
    out.push({ series_key: r.provider_key, code: r.provider_code, grandeur, step_ms: DAY_MS });
  }
  return out;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export const provider: Provider = {
  units,
  chunkRequest(spec, unit: Fr2Unit, chunk): Req {
    // The chunk is [from, to) in UTC days: the last day asked is the one before `to`.
    const q = [
      `code_entite=${encodeURIComponent(unit.code)}`,
      `grandeur_hydro_elab=${encodeURIComponent(unit.grandeur)}`,
      `date_debut_obs_elab=${encodeURIComponent(day(chunk.from))}`,
      `date_fin_obs_elab=${encodeURIComponent(day(new Date(chunk.to.getTime() - DAY_MS)))}`,
      `size=${SIZE}`,
    ];
    return {
      url: `${fr2Spec(spec).url}?${q.join('&')}`,
      method: 'GET',
      headers: { accept: 'application/json' },
      variant: unit.series_key,
    };
  },
  inspect(body) {
    try {
      const page = parseElab(body);
      // A 206 carries a `next`, and `count` is the walk's total: either way the answer is a page, not the chunk.
      if (page.next !== null || page.count > page.data.length) return { ok: false, code: 'truncated' };
      return { ok: true, values: page.data.length };
    } catch (err) {
      if (err instanceof SchemaDrift)
        return CAP_CODES.has(err.code)
          ? { ok: false, code: 'truncated' }
          : { ok: false, code: 'schema_drift', drift: driftCode(err) };
      throw err;
    }
  },
  validity: {
    format: 'json',
    required: ['count', 'data'],
    reject: [],
    count: 'data',
    min: 0,
    allow_status: [204],
    end_html: false,
  },
  okStatus: [200, 204, 206],
  // Measured on the fixtures: 382 B a record; the archive's zstd -9 gets 52 on 400 days and 41 on 139, 60 to 77 on a
  // full answer (a long chunk compresses better than a short one: 45 overstates the archive a little).
  dryRun: { bytes_per_value: 383, zstd_ratio: 45, db_bytes_per_row: 90 },
};
