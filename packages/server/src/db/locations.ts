/**
 * Location storage.
 *
 * Rows are never deleted. A station that goes quiet is marked inactive and
 * comes back when it resumes, keeping its history and its identity. Every
 * transition is written to location_events so a shrinking map is explainable.
 */

import type { PoolClient } from 'pg';
import type { Location } from '@rws/shared';
import { getPool, withTransaction } from './pool.js';

export interface LocationUpsert {
  code: string;
  name: string;
  lat: number | null;
  lon: number | null;
  lastSeenAt: string;
}

export interface UpsertSummary {
  total: number;
  created: number;
  activated: number;
  deactivated: number;
}

/**
 * Upsert the whole location set and reconcile the active flag in one pass.
 *
 * `activeCutoff` is the instant before which a location counts as stale. Any
 * stored location not present in `rows` is evaluated too, so a station that
 * disappears from the layer entirely is deactivated rather than left stuck on.
 */
export async function upsertLocations(
  rows: LocationUpsert[],
  activeCutoff: Date,
): Promise<UpsertSummary> {
  return withTransaction(async (client) => {
    await client.query(`
      CREATE TEMP TABLE incoming_locations (
        code text PRIMARY KEY,
        name text NOT NULL,
        lat double precision,
        lon double precision,
        last_seen_at timestamptz NOT NULL
      ) ON COMMIT DROP
    `);

    // One round trip for the whole set rather than a statement per location.
    await client.query(
      `INSERT INTO incoming_locations (code, name, lat, lon, last_seen_at)
       SELECT * FROM unnest($1::text[], $2::text[], $3::float8[], $4::float8[], $5::timestamptz[])`,
      [
        rows.map((r) => r.code),
        rows.map((r) => r.name),
        rows.map((r) => r.lat),
        rows.map((r) => r.lon),
        rows.map((r) => r.lastSeenAt),
      ],
    );

    const { rows: createdRows } = await client.query<{ code: string }>(
      `INSERT INTO locations (code, name, lat, lon, last_seen_at, active)
       SELECT i.code, i.name, i.lat, i.lon, i.last_seen_at, i.last_seen_at >= $1
       FROM incoming_locations i
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name,
         -- Keep known coordinates if the layer omits them this time round.
         lat = COALESCE(EXCLUDED.lat, locations.lat),
         lon = COALESCE(EXCLUDED.lon, locations.lon),
         last_seen_at = GREATEST(locations.last_seen_at, EXCLUDED.last_seen_at),
         updated_at = now()
       RETURNING code, (xmax = 0) AS inserted`,
      [activeCutoff.toISOString()],
    ).then((res) => ({
      rows: (res.rows as unknown as { code: string; inserted: boolean }[]).filter((r) => r.inserted),
    }));

    for (const row of createdRows) {
      await client.query(
        `INSERT INTO location_events (location_code, event, last_seen_at, reason)
         VALUES ($1, 'created', (SELECT last_seen_at FROM locations WHERE code = $1), $2)`,
        [row.code, 'first seen in locatiesmetlaatstewaarneming'],
      );
    }

    // Reconcile active across every stored location, not just the incoming set.
    const activated = await flipActive(client, true, activeCutoff);
    const deactivated = await flipActive(client, false, activeCutoff);

    return {
      total: rows.length,
      created: createdRows.length,
      activated: activated.length,
      deactivated: deactivated.length,
    };
  });
}

async function flipActive(
  client: PoolClient,
  toActive: boolean,
  cutoff: Date,
): Promise<string[]> {
  const { rows } = await client.query<{ code: string }>(
    `UPDATE locations
        SET active = $1, updated_at = now()
      WHERE active = $2
        AND ${toActive ? 'last_seen_at >= $3' : '(last_seen_at IS NULL OR last_seen_at < $3)'}
      RETURNING code`,
    [toActive, !toActive, cutoff.toISOString()],
  );

  for (const row of rows) {
    await client.query(
      `INSERT INTO location_events (location_code, event, last_seen_at, reason)
       VALUES ($1, $2, (SELECT last_seen_at FROM locations WHERE code = $1), $3)`,
      [
        row.code,
        toActive ? 'activated' : 'deactivated',
        toActive
          ? 'latest observation is within the active window'
          : 'latest observation fell outside the active window',
      ],
    );
  }

  return rows.map((r) => r.code);
}

export interface ListLocationsFilter {
  includeInactive?: boolean;
  grootheid?: string;
  compartiment?: string;
  /** [west, south, east, north] in WGS84 degrees. */
  bbox?: [number, number, number, number];
  q?: string;
  limit?: number;
}

export async function listLocations(filter: ListLocationsFilter = {}): Promise<Location[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!filter.includeInactive) conditions.push('l.active');

  if (filter.grootheid) {
    params.push(filter.grootheid);
    conditions.push(
      `EXISTS (SELECT 1 FROM location_quantities q
                WHERE q.location_code = l.code AND q.grootheid = $${params.length})`,
    );
  }

  if (filter.compartiment) {
    params.push(filter.compartiment);
    conditions.push(
      `EXISTS (SELECT 1 FROM location_quantities q
                WHERE q.location_code = l.code AND q.compartiment = $${params.length})`,
    );
  }

  if (filter.bbox) {
    const [west, south, east, north] = filter.bbox;
    params.push(west, south, east, north);
    const n = params.length;
    conditions.push(
      `l.lon BETWEEN $${n - 3} AND $${n - 1} AND l.lat BETWEEN $${n - 2} AND $${n}`,
    );
  }

  if (filter.q) {
    params.push(`%${filter.q.toLowerCase()}%`);
    conditions.push(`(lower(l.name) LIKE $${params.length} OR l.code LIKE $${params.length})`);
  }

  params.push(Math.min(filter.limit ?? 10_000, 25_000));

  const { rows } = await getPool().query<{
    code: string;
    name: string;
    lat: number | null;
    lon: number | null;
    active: boolean;
    last_seen_at: Date | null;
    quantities: string[] | null;
  }>(
    `SELECT l.code, l.name, l.lat, l.lon, l.active, l.last_seen_at,
            (SELECT array_agg(DISTINCT q.grootheid ORDER BY q.grootheid)
               FROM location_quantities q WHERE q.location_code = l.code) AS quantities
       FROM locations l
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY l.name
      LIMIT $${params.length}`,
    params,
  );

  return rows.map(toLocation);
}

export async function getLocation(code: string): Promise<Location | null> {
  const { rows } = await getPool().query(
    `SELECT l.code, l.name, l.lat, l.lon, l.active, l.last_seen_at,
            (SELECT array_agg(DISTINCT q.grootheid ORDER BY q.grootheid)
               FROM location_quantities q WHERE q.location_code = l.code) AS quantities
       FROM locations l
      WHERE l.code = $1`,
    [code.toLowerCase()],
  );
  const row = rows[0];
  return row ? toLocation(row) : null;
}

function toLocation(row: {
  code: string;
  name: string;
  lat: number | null;
  lon: number | null;
  active: boolean;
  last_seen_at: Date | null;
  quantities: string[] | null;
}): Location {
  return {
    code: row.code,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    active: row.active,
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    quantities: row.quantities ?? [],
  };
}

export async function locationCounts(): Promise<{ total: number; active: number }> {
  const { rows } = await getPool().query<{ total: number; active: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE active)::int AS active
       FROM locations`,
  );
  return rows[0] ?? { total: 0, active: 0 };
}
