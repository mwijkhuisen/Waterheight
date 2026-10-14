import { SchemaDrift } from '@rws/core';
import { buildCheck, adapter as nl1 } from '../adapters/nl-1/capture.ts';
import { JSON_CAPS, parseCheck, parseWaarnemingen } from '../adapters/nl-1/parse.ts';
import type { ValiditySpec } from '../archive/validity.ts';
import type { Req } from '../http/types.ts';
import type { Chunk } from './plan.ts';
import type { LoadedBackfillSpec, Series } from './spec.ts';

// What the runner needs of a source (P14a): the chunk request, the probe request and the probe answer, and the
// truncation check of a response. NL-1 is the only source with a backfill so far; the next one adds a row to
// PROVIDERS. Requests are built only from the registry row and the spec (invariant 1).

export type Inspect = { ok: true; values: number } | { ok: false; code: 'truncated' | 'schema_drift' };

export type Provider = {
  chunkRequest(spec: LoadedBackfillSpec, series: Series, chunk: Chunk, now: Date): Req;
  checkRequest(spec: LoadedBackfillSpec, series: Series, from: Date, to: Date): Req;
  parseCheck(body: Uint8Array): boolean;
  /** Parses a response and refuses one that may be cut short by the provider's cap. */
  inspect(body: Uint8Array): Inspect;
  validity: ValiditySpec;
};

const HEADERS = { 'content-type': 'application/json', accept: 'application/json' };
/** RWS answers at most 160,000 values a request (research nl-rws §2.1); at 90 % we call the response cut. */
export const PROVIDER_VALUE_CAP = 160_000;
/** A parse cap error means the response outgrew what we read; any other drift is the parser's own. */
const CAP_CODES = new Set(['too_big', 'json_too_many_nodes', 'json_too_deep']);

const nl1Provider: Provider = {
  chunkRequest(spec, series, chunk, now) {
    const base: Req = { url: spec.url, method: 'POST', headers: { ...HEADERS }, variant: series.series_key };
    return (nl1.build as NonNullable<typeof nl1.build>)({
      req: base,
      row: { code: series.code, quantity: series.quantity },
      now,
      window: chunk,
      params: { proces: 'meting', hoedanigheid: series.hoedanigheid },
    });
  },
  checkRequest(spec, series, from, to) {
    return {
      url: spec.check_url,
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
        return { ok: false, code: CAP_CODES.has(err.code) ? 'truncated' : 'schema_drift' };
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

export const PROVIDERS: Readonly<Record<string, Provider>> = { 'NL-1': nl1Provider };
