/**
 * Catalogue refresh — the Aquo code lists used for filter labels.
 *
 * Measured at ~1.2 s live, which is far quicker than Rijkswaterstaat's own
 * documentation warns. It is still fetched on a schedule and persisted rather
 * than called in a request path: it returns ~6.5 MB, almost all of which is
 * cross-references we discard.
 */

import { getPool } from '../db/pool.js';
import { fetchCatalogue } from '../rws/client.js';
import { normaliseCatalogue } from '../rws/normalise.js';
import { recordRefresh } from './locations.js';

export interface RefreshCatalogueResult {
  codes: number;
  durationMs: number;
}

export async function refreshCatalogue(
  log: (msg: string) => void = console.log,
): Promise<RefreshCatalogueResult> {
  const started = Date.now();
  log('[refresh] fetching catalogue...');

  const response = await fetchCatalogue();
  if (!response.data) {
    // 204 here would mean the catalogue is empty, which is not a real state.
    throw new Error(`Catalogue returned ${response.status} with no body`);
  }

  const rows = normaliseCatalogue(response.data);
  if (rows.length > 0) {
    await getPool().query(
      `INSERT INTO aquo_codes (domain, code, description)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
       ON CONFLICT (domain, code) DO UPDATE SET
         description = COALESCE(EXCLUDED.description, aquo_codes.description),
         updated_at = now()`,
      [
        rows.map((r) => r.domain),
        rows.map((r) => r.code),
        rows.map((r) => r.description),
      ],
    );
  }

  await recordRefresh('catalogue', { codes: rows.length, latencyMs: response.latencyMs });
  const durationMs = Date.now() - started;
  log(`[refresh] catalogue: ${rows.length} codes (${durationMs} ms)`);

  return { codes: rows.length, durationMs };
}

/** Code -> description lookups for labelling API responses. */
export async function loadLabels(domain: string): Promise<Map<string, string | null>> {
  const { rows } = await getPool().query<{ code: string; description: string | null }>(
    'SELECT code, description FROM aquo_codes WHERE domain = $1',
    [domain],
  );
  return new Map(rows.map((r) => [r.code, r.description]));
}
