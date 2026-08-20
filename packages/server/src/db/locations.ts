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

/** One (location, quantity) pair, as `location_quantities` records it. */
export interface QuantityPair {
  locationCode: string;
  compartiment: string;
  grootheid: string;
}

/**
 * Pairs the latest poll cannot ask for narrowly yet: the WFS layer says the
 * location published this quantity recently, but no series of ours carries a
 * point from within the poll's freshness window.
 *
 * That covers a system whose observation store is still empty, a station that
 * has just resumed, and a station that has switched instrument -- in every
 * case the full metadata that makes a narrow request possible is only
 * discoverable by fetching actual observations.
 *
 * Ordered oldest-probe-first so a bounded number per cycle still gives every
 * pair its turn.
 */
export async function listPairsToDiscover(
  publishedSince: Date,
  liveSince: Date,
  limit: number,
): Promise<QuantityPair[]> {
  if (limit <= 0) return [];
  const { rows } = await getPool().query<{
    location_code: string; compartiment: string; grootheid: string;
  }>(
    `SELECT q.location_code, q.compartiment, q.grootheid
       FROM location_quantities q
       JOIN locations l ON l.code = q.location_code AND l.active
      WHERE q.last_seen_at >= $1
        AND NOT EXISTS (
          SELECT 1 FROM series s
           WHERE s.location_code = q.location_code
             AND s.compartiment = q.compartiment
             AND s.grootheid = q.grootheid
             AND s.last_observed_at >= $2)
      ORDER BY q.polled_at NULLS FIRST, q.last_seen_at DESC
      LIMIT $3`,
    [publishedSince.toISOString(), liveSince.toISOString(), limit],
  );

  return rows.map((r) => ({
    locationCode: r.location_code,
    compartiment: r.compartiment,
    grootheid: r.grootheid,
  }));
}

/**
 * Record that these pairs have had their turn, whether or not upstream had
 * anything to say. Marking only the productive ones would leave a pair that
 * never answers at the head of the queue forever.
 */
export async function markPairsPolled(pairs: QuantityPair[]): Promise<void> {
  if (pairs.length === 0) return;
  await getPool().query(
    `UPDATE location_quantities q SET polled_at = now()
       FROM unnest($1::text[], $2::text[], $3::text[]) AS t(code, compartiment, grootheid)
      WHERE q.location_code = t.code
        AND q.compartiment = t.compartiment
        AND q.grootheid = t.grootheid`,
    [
      pairs.map((p) => p.locationCode),
      pairs.map((p) => p.compartiment),
      pairs.map((p) => p.grootheid),
    ],
  );
}

export interface FreshnessTouch extends QuantityPair {
  /** ISO 8601 UTC timestamp of the reading. */
  observedAt: string;
  value: number | null;
}

/**
 * Carry a freshly polled reading through to the layers the map reads.
 *
 * Without this the map's marker colours and the per-quantity latest value
 * would only move when the daily WFS refresh runs, so a five-minute poll
 * would be invisible outside the charts. Timestamps only ever move forward:
 * the poll and the refresh write the same columns and must not undo each
 * other, whichever ran last.
 */
export async function touchFreshness(rows: FreshnessTouch[]): Promise<void> {
  if (rows.length === 0) return;

  // Newest reading per pair, and per location, so each row is written once.
  const byPair = new Map<string, FreshnessTouch>();
  for (const row of rows) {
    const key = `${row.locationCode}|${row.compartiment}|${row.grootheid}`;
    const current = byPair.get(key);
    if (!current || row.observedAt > current.observedAt) byPair.set(key, row);
  }
  const pairs = [...byPair.values()];

  const byLocation = new Map<string, string>();
  for (const row of pairs) {
    const current = byLocation.get(row.locationCode);
    if (!current || row.observedAt > current) byLocation.set(row.locationCode, row.observedAt);
  }

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE location_quantities q SET
         last_seen_at = GREATEST(q.last_seen_at, t.observed_at),
         latest_value = CASE WHEN t.observed_at >= q.last_seen_at
                             THEN t.value ELSE q.latest_value END,
         polled_at = now(),
         updated_at = now()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::float8[])
            AS t(code, compartiment, grootheid, observed_at, value)
      WHERE q.location_code = t.code
        AND q.compartiment = t.compartiment
        AND q.grootheid = t.grootheid`,
      [
        pairs.map((p) => p.locationCode),
        pairs.map((p) => p.compartiment),
        pairs.map((p) => p.grootheid),
        pairs.map((p) => p.observedAt),
        pairs.map((p) => p.value),
      ],
    );

    await client.query(
      `UPDATE locations l SET
         last_seen_at = GREATEST(l.last_seen_at, t.observed_at),
         updated_at = now()
       FROM unnest($1::text[], $2::timestamptz[]) AS t(code, observed_at)
      WHERE l.code = t.code`,
      [[...byLocation.keys()], [...byLocation.values()]],
    );
  });
}
