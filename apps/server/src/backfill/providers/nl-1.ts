import { readFileSync } from 'node:fs';
import { SchemaDrift } from '@rws/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { buildCheck, adapter as nl1 } from '../../adapters/nl-1/capture.ts';
import { JSON_CAPS, parseCheck, parseWaarnemingen } from '../../adapters/nl-1/parse.ts';
import { durationMs, REGISTRY_DIR } from '../../capture/specs.ts';
import type { Req } from '../../http/types.ts';
import { driftCode } from '../drift.ts';
import type { Provider } from '../provider.ts';
import type { BackfillSpecAny, LoadedBackfillSpec, Nl1BackfillSpec, Series } from '../spec.ts';

// The NL-1 backfill provider (P14a; moved here in P14b): the series of the spec from registry/stations/nl-1.yaml,
// one OphalenWaarnemingen POST per chunk and the yearly CheckWaarnemingenAanwezig probe. Requests are built only from
// the registry row and the spec (invariant 1). Only types come from spec.ts, which imports PROVIDERS.

const StationRow = z.looseObject({
  provider_code: z.string(),
  provider_key: z.string(),
  quantity: z.enum(['H', 'Q']),
  role: z.string(),
  first_release: z.boolean(),
  audience: z.string(),
  native_step: z.string().optional(),
});
const StationsFile = z.looseObject({ stations: z.array(StationRow) });

const QUANTITY = { WATHTE: 'H', Q: 'Q' } as const;

/**
 * The series a spec selects: its source's station rows with `first_release`, the asked quantity, `role: primary`
 * (never the TAW twin) and an audience other than `off`. A row whose key is not `<code>/<Grootheid>/<Hoedanigheid>/
 * <method>`, or a selected row that is not `public` like its source (review S8: the ledger and `detail.backfill`
 * count per source, so an owner-narrowed series would reach public health), is a registry fault.
 */
export function resolveSeries(spec: Nl1BackfillSpec, dir: URL = REGISTRY_DIR): Series[] {
  const file = StationsFile.parse(
    parseYaml(readFileSync(new URL(`stations/${spec.source.toLowerCase()}.yaml`, dir), 'utf8')),
  );
  const wanted = new Set(spec.select.quantities.map((q) => QUANTITY[q]));
  const out: Series[] = [];
  for (const r of file.stations) {
    if (!r.first_release || r.role !== spec.select.role || r.audience === 'off' || !wanted.has(r.quantity)) continue;
    const [code, grootheid, hoedanigheid, method, ...rest] = r.provider_key.split('/');
    if (
      rest.length > 0 ||
      code !== r.provider_code ||
      grootheid !== (r.quantity === 'H' ? 'WATHTE' : 'Q') ||
      !hoedanigheid ||
      !method
    )
      throw new Error(`registry/stations: ${r.provider_key} is not a series key of ${r.provider_code}`);
    if (hoedanigheid === 'TAW') continue;
    if (r.audience !== 'public')
      throw new Error(`registry/stations: ${r.provider_key} is not public like its source; a backfill selects none`);
    out.push({
      series_key: r.provider_key,
      code,
      quantity: r.quantity,
      hoedanigheid,
      method,
      step_ms: r.native_step === undefined ? 600_000 : durationMs(r.native_step),
    });
  }
  return out;
}

const HEADERS = { 'content-type': 'application/json', accept: 'application/json' };
/** RWS answers at most 160,000 values a request (research nl-rws §2.1); at 90 % we call the response cut. */
export const PROVIDER_VALUE_CAP = 160_000;
/** A parse cap error means the response outgrew what we read; any other drift is the parser's own. */
const CAP_CODES = new Set(['too_big', 'json_too_many_nodes', 'json_too_deep']);

const nl1Spec = (spec: BackfillSpecAny | LoadedBackfillSpec): Nl1BackfillSpec & { check_url: string } => {
  if (spec.source !== 'NL-1') throw new Error('backfill: the NL-1 provider got another source');
  return spec;
};

export const provider: Provider = {
  units: (spec, dir) => resolveSeries(nl1Spec(spec), dir),
  chunkRequest(spec, series: Series, chunk, now) {
    const base: Req = { url: spec.url, method: 'POST', headers: { ...HEADERS }, variant: series.series_key };
    return (nl1.build as NonNullable<typeof nl1.build>)({
      req: base,
      row: { code: series.code, quantity: series.quantity },
      now,
      window: chunk,
      params: { proces: 'meting', hoedanigheid: series.hoedanigheid },
    });
  },
  checkRequest(spec, series: Series, from, to) {
    return {
      url: nl1Spec(spec).check_url,
      method: 'POST',
      headers: { ...HEADERS },
      variant: series.series_key,
      body: buildCheck(
        { code: series.code, quantity: series.quantity, hoedanigheid: series.hoedanigheid },
        from,
        to,
        series.method,
      ),
    };
  },
  parseCheck,
  inspect(body) {
    try {
      const lists = parseWaarnemingen(body);
      const values = lists.reduce((n, l) => n + l.metingen.length, 0);
      const longest = Math.max(0, ...lists.map((l) => l.metingen.length));
      if (longest >= 0.9 * JSON_CAPS.maxValues || values >= 0.9 * PROVIDER_VALUE_CAP)
        return { ok: false, code: 'truncated' };
      return { ok: true, values };
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
    required: ['Succesvol'],
    reject: [],
    count: 'WaarnemingenLijst',
    min: 0,
    allow_status: [204],
    end_html: false,
  },
};
