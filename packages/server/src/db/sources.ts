/**
 * Source storage.
 *
 * The `sources` table is a projection of the registry in ../sources/registry.js,
 * not a second source of truth. It exists so location rows can carry a foreign
 * key, and so `/api/sources` can serve attribution from the database rather
 * than the client hard-coding it -- which is what stops a source shipping
 * without its credit.
 */

import type { SourceInfo } from '@rws/shared';
import { getPool } from './pool.js';
import { listSources } from '../sources/registry.js';

/**
 * Push the code registry into the table.
 *
 * Runs at startup and after migrations, so adding a source is a code change
 * rather than a code change plus a migration. Rows are never deleted: a source
 * that is removed from the registry still has locations pointing at it, and
 * dropping the row would fail the foreign key or orphan the history.
 */
export async function syncSources(): Promise<number> {
  const sources = listSources();
  if (sources.length === 0) return 0;

  const { rowCount } = await getPool().query(
    `INSERT INTO sources (id, name, country, attribution, licence, base_url)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       country = EXCLUDED.country,
       attribution = EXCLUDED.attribution,
       licence = EXCLUDED.licence,
       base_url = EXCLUDED.base_url,
       updated_at = now()`,
    [
      sources.map((s) => s.id),
      sources.map((s) => s.name),
      sources.map((s) => s.country),
      sources.map((s) => s.attribution),
      sources.map((s) => s.licence),
      sources.map((s) => s.baseUrl),
    ],
  );
  return rowCount ?? 0;
}

/** Sources with the size of what each currently contributes to the map. */
export async function listSourceInfo(): Promise<SourceInfo[]> {
  const { rows } = await getPool().query<{
    id: string;
    name: string;
    country: string;
    attribution: string;
    licence: string;
    locations: number;
    active_locations: number;
  }>(
    `SELECT s.id, s.name, s.country, s.attribution, s.licence,
            count(l.code)::int AS locations,
            count(l.code) FILTER (WHERE l.active)::int AS active_locations
       FROM sources s
       LEFT JOIN locations l ON l.source_id = s.id
      GROUP BY s.id, s.name, s.country, s.attribution, s.licence
      ORDER BY s.id`,
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    country: r.country,
    attribution: r.attribution,
    licence: r.licence,
    locations: r.locations,
    activeLocations: r.active_locations,
  }));
}
