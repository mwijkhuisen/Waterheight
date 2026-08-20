/**
 * Series storage — the synthetic ids that observations hang off.
 *
 * See migration 004 for why (location, quantity) is not enough to identify a
 * measurement stream.
 */

import type { PoolClient } from 'pg';
import type { MeasurementType } from '@rws/shared';
import type { SeriesIdentity } from '../sources/rws/normalise.js';
import { getPool } from './pool.js';
import { resolveLocationKey } from '../sources/registry.js';

/**
 * Resolve a series to its id, creating it if new.
 *
 * Conflicts on natural_key rather than a 20-column composite target. The
 * DO UPDATE is a no-op touch so RETURNING yields the id on both paths.
 */
export async function upsertSeries(
  client: PoolClient,
  identity: SeriesIdentity,
): Promise<number> {
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO series (
       location_code, compartiment, grootheid, eenheid, parameter, proces_type,
       hoedanigheid, typering, orgaan, biotaxon, groepering,
       bemonstering_apparaat, bemonstering_methode, bemonstering_soort, meetapparaat,
       waardebepaling_methode, waardebepaling_techniek, waardebewerking_methode,
       bemonsteringshoogte, referentievlak, opdrachtgevende_instantie,
       description, natural_key
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
     )
     ON CONFLICT (natural_key) DO UPDATE
       SET updated_at = now(),
           eenheid = COALESCE(EXCLUDED.eenheid, series.eenheid),
           description = COALESCE(EXCLUDED.description, series.description)
     RETURNING id`,
    [
      identity.locationCode, identity.compartiment, identity.grootheid,
      identity.eenheid, identity.parameter, identity.procesType,
      identity.hoedanigheid, identity.typering, identity.orgaan,
      identity.biotaxon, identity.groepering,
      identity.bemonsteringApparaat, identity.bemonsteringMethode,
      identity.bemonsteringSoort, identity.meetapparaat,
      identity.waardebepalingMethode, identity.waardebepalingTechniek,
      identity.waardebewerkingMethode,
      identity.bemonsteringshoogte, identity.referentievlak,
      identity.opdrachtgevendeInstantie,
      identity.description, identity.naturalKey,
    ],
  );
  return rows[0]!.id;
}

export interface SeriesRow {
  id: number;
  locationCode: string;
  compartiment: string;
  grootheid: string;
  eenheid: string | null;
  procesType: string;
  description: string | null;
  discriminators: Record<string, string | null>;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  pointCount: number;
}

interface RawSeriesRow {
  id: number;
  location_code: string;
  compartiment: string;
  grootheid: string;
  eenheid: string | null;
  proces_type: string;
  description: string | null;
  bemonsteringshoogte: string | null;
  meetapparaat: string | null;
  bemonstering_methode: string | null;
  bemonstering_soort: string | null;
  referentievlak: string | null;
  opdrachtgevende_instantie: string | null;
  first_observed_at: Date | null;
  last_observed_at: Date | null;
  point_count: number;
}

const SERIES_COLUMNS = `
  id, location_code, compartiment, grootheid, eenheid, proces_type, description,
  bemonsteringshoogte, meetapparaat, bemonstering_methode, bemonstering_soort,
  referentievlak, opdrachtgevende_instantie,
  first_observed_at, last_observed_at, point_count
`;

function toSeriesRow(r: RawSeriesRow): SeriesRow {
  return {
    id: r.id,
    locationCode: r.location_code,
    compartiment: r.compartiment,
    grootheid: r.grootheid,
    eenheid: r.eenheid,
    procesType: r.proces_type,
    description: r.description,
    // Only the dimensions a human might use to tell two sibling series apart.
    discriminators: {
      samplingHeight: r.bemonsteringshoogte,
      instrument: r.meetapparaat,
      samplingMethod: r.bemonstering_methode,
      samplingType: r.bemonstering_soort,
      referenceLevel: r.referentievlak,
      owner: r.opdrachtgevende_instantie,
    },
    firstObservedAt: r.first_observed_at?.toISOString() ?? null,
    lastObservedAt: r.last_observed_at?.toISOString() ?? null,
    pointCount: r.point_count,
  };
}

export async function listSeriesForLocation(locationCode: string): Promise<SeriesRow[]> {
  const { rows } = await getPool().query<RawSeriesRow>(
    `SELECT ${SERIES_COLUMNS} FROM series
      WHERE location_code = $1
      ORDER BY grootheid, id`,
    [resolveLocationKey(locationCode)],
  );
  return rows.map(toSeriesRow);
}

/**
 * Pick the series to chart for a (location, quantity) pair.
 *
 * A location can have several series for one quantity; the UI shows one by
 * default, and the richest is the least surprising choice.
 */
export async function findSeries(
  locationCode: string,
  grootheid: string,
  options: { compartiment?: string; procesType?: string } = {},
): Promise<SeriesRow | null> {
  const params: unknown[] = [resolveLocationKey(locationCode), grootheid];
  let extra = '';
  if (options.compartiment) {
    params.push(options.compartiment);
    extra += ` AND compartiment = $${params.length}`;
  }
  params.push(options.procesType ?? 'meting');
  extra += ` AND proces_type = $${params.length}`;

  const { rows } = await getPool().query<RawSeriesRow>(
    `SELECT ${SERIES_COLUMNS} FROM series
      WHERE location_code = $1 AND grootheid = $2${extra}
      ORDER BY point_count DESC, id
      LIMIT 1`,
    params,
  );
  return rows[0] ? toSeriesRow(rows[0]) : null;
}

export function toMeasurementType(
  row: SeriesRow,
  labels: { quantity: string | null; compartment: string | null },
): MeasurementType {
  return {
    seriesId: row.id,
    quantity: row.grootheid,
    quantityLabel: labels.quantity ?? row.description,
    compartment: row.compartiment,
    compartmentLabel: labels.compartment,
    unit: row.eenheid,
    procesType: row.procesType,
    discriminators: row.discriminators,
    coverage: {
      from: row.firstObservedAt,
      to: row.lastObservedAt,
      points: row.pointCount,
    },
  };
}

/**
 * Recompute the denormalised coverage columns after an ingest.
 *
 * Kept on the series row so the detail endpoint does not scan the hypertable
 * once per series on every page load.
 */
export async function refreshCoverage(client: PoolClient, seriesIds: number[]): Promise<void> {
  if (seriesIds.length === 0) return;
  await client.query(
    `UPDATE series s SET
       first_observed_at = agg.min_ts,
       last_observed_at = agg.max_ts,
       point_count = agg.n,
       updated_at = now()
     FROM (
       SELECT series_id, min(ts) AS min_ts, max(ts) AS max_ts, count(*) AS n
         FROM observations
        WHERE series_id = ANY($1::bigint[])
        GROUP BY series_id
     ) agg
     WHERE s.id = agg.series_id`,
    [seriesIds],
  );
}

/**
 * One live series, as the latest poll needs to see it.
 *
 * The filter dimensions are the ones OphalenLaatsteWaarnemingen accepts; the
 * rest of a series' identity (sampling height, reference level) lives in the
 * measurement rather than the AquoMetadata and cannot be asked for, so several
 * of these can collapse onto one upstream request. The response carries all of
 * them and `naturalKey` tells them apart again on the way back in -- which is
 * also what lets the writer skip a series whose newest point it already has.
 */
export interface PollTarget {
  id: number;
  naturalKey: string;
  locationCode: string;
  compartiment: string;
  grootheid: string;
  procesType: string;
  parameter: string | null;
  meetapparaat: string | null;
  waardebepalingMethode: string | null;
  lastObservedAt: string | null;
}

/**
 * The series worth polling for a new reading: those at an active location of
 * one source whose newest stored point is younger than `cutoff`.
 *
 * Scoped to a source because the poll speaks that source's protocol -- asking
 * Rijkswaterstaat about a PEGELONLINE station returns an empty answer rather
 * than an error, which is the kind of failure that looks like a quiet station.
 *
 * A series quiet for longer than the cut-off drops out, and the discovery pass
 * picks it up again -- which is how a station returning from maintenance, or
 * one that has swapped instruments, comes back without anyone intervening.
 */
export async function listPollTargets(
  sourceId: string,
  cutoff: Date,
): Promise<PollTarget[]> {
  const { rows } = await getPool().query<{
    id: string | number; natural_key: string; location_code: string;
    compartiment: string; grootheid: string; proces_type: string;
    parameter: string | null; meetapparaat: string | null;
    waardebepaling_methode: string | null; last_observed_at: Date | null;
  }>(
    `SELECT s.id, s.natural_key, s.location_code, s.compartiment, s.grootheid,
            s.proces_type, s.parameter, s.meetapparaat, s.waardebepaling_methode,
            s.last_observed_at
       FROM series s
       JOIN locations l ON l.code = s.location_code AND l.active
      WHERE l.source_id = $1 AND s.last_observed_at >= $2
      ORDER BY s.compartiment, s.grootheid, s.location_code, s.id`,
    [sourceId, cutoff.toISOString()],
  );

  return rows.map((r) => ({
    id: Number(r.id),
    naturalKey: r.natural_key,
    locationCode: r.location_code,
    compartiment: r.compartiment,
    grootheid: r.grootheid,
    procesType: r.proces_type,
    parameter: r.parameter,
    meetapparaat: r.meetapparaat,
    waardebepalingMethode: r.waardebepaling_methode,
    lastObservedAt: r.last_observed_at?.toISOString() ?? null,
  }));
}

/**
 * Move the denormalised coverage forward after an append, without recounting.
 *
 * `refreshCoverage` recomputes from the hypertable, which is right after a
 * backfill chunk rewrites a month in place but far too heavy for a poll:
 * every live series, every five minutes, against a table sized in the hundreds
 * of millions. Here the writer already knows what it added, so the columns can
 * be advanced arithmetically. Bounds only ever widen, so an out-of-order write
 * cannot shrink a series' known range.
 */
export async function advanceCoverage(
  client: PoolClient,
  spans: { seriesId: number; from: string; to: string; inserted: number }[],
): Promise<void> {
  if (spans.length === 0) return;
  await client.query(
    `UPDATE series s SET
       first_observed_at = LEAST(COALESCE(s.first_observed_at, t.from_ts), t.from_ts),
       last_observed_at = GREATEST(COALESCE(s.last_observed_at, t.to_ts), t.to_ts),
       point_count = s.point_count + t.inserted,
       updated_at = now()
     FROM unnest($1::bigint[], $2::timestamptz[], $3::timestamptz[], $4::bigint[])
          AS t(series_id, from_ts, to_ts, inserted)
    WHERE s.id = t.series_id`,
    [
      spans.map((s) => s.seriesId),
      spans.map((s) => s.from),
      spans.map((s) => s.to),
      spans.map((s) => s.inserted),
    ],
  );
}
