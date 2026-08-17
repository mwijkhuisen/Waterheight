/**
 * The public API.
 *
 * Rules that apply throughout: no raw Rijkswaterstaat field names reach the
 * client, all timestamps are ISO 8601 in UTC, errors use one envelope, and an
 * upstream 204 becomes an empty result rather than an error.
 */

import type { FastifyInstance } from 'fastify';
import {
  DISPLAY_QUALITY_CODES,
  type HealthResponse,
  type LatestValue,
  type LocationDetail,
  type ObservationsResponse,
  type QuantitiesResponse,
} from '@rws/shared';

import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { getLocation, listLocations, locationCounts } from '../db/locations.js';
import { findSeries, listSeriesForLocation, toMeasurementType } from '../db/series.js';
import {
  readLatestForLocation,
  readObservations,
  refreshAggregates,
  selectResolution,
} from '../db/observations.js';
import { loadLabels } from '../ingest/catalogue.js';
import { getRefreshState } from '../ingest/locations.js';
import { backfillProgress } from '../db/backfill.js';
import { ensureObservations } from '../ingest/observations.js';
import { HttpError, badRequest, notFound, upstreamFailure } from './errors.js';
import {
  parseBbox,
  parseBoolean,
  parseInteger,
  parseResolution,
  parseString,
  parseWindow,
} from './parse.js';

/**
 * Which compartment a location measures a quantity in.
 *
 * Callers may omit `compartiment`, but an upstream fetch needs one. The WFS
 * layer already records the pairing, so look it up rather than guessing 'OW'.
 */
async function defaultCompartimentFor(
  locationCode: string,
  grootheid: string,
): Promise<string | null> {
  const { rows } = await getPool().query<{ compartiment: string }>(
    `SELECT compartiment FROM location_quantities
      WHERE location_code = $1 AND grootheid = $2
      ORDER BY last_seen_at DESC
      LIMIT 1`,
    [locationCode.toLowerCase(), grootheid],
  );
  return rows[0]?.compartiment ?? null;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/locations', async (request) => {
    const q = request.query as Record<string, unknown>;
    return listLocations({
      includeInactive: parseBoolean(q['includeInactive'], 'includeInactive') ?? false,
      grootheid: parseString(q['grootheid'], 'grootheid', 50),
      compartiment: parseString(q['compartiment'], 'compartiment', 50),
      bbox: parseBbox(q['bbox']),
      q: parseString(q['q'], 'q'),
      limit: parseInteger(q['limit'], 'limit', 1, 25_000),
    });
  });

  app.get('/api/locations/:code', async (request): Promise<LocationDetail> => {
    const { code } = request.params as { code: string };
    const location = await getLocation(code);
    if (!location) throw notFound(`No location with code ${code}`);

    const [series, quantityLabels, compartmentLabels] = await Promise.all([
      listSeriesForLocation(code),
      loadLabels('grootheid'),
      loadLabels('compartiment'),
    ]);

    // Series exist only for quantities whose observations have been fetched, so
    // the panel is built from both sources: fetched series carry real coverage,
    // and everything else the WFS layer says this location publishes is listed
    // with empty coverage. Listing only the fetched ones would make the rest of
    // a location's measurements invisible until something happened to fetch them.
    const measurementTypes = series.map((s) =>
      toMeasurementType(s, {
        quantity: quantityLabels.get(s.grootheid) ?? null,
        compartment: compartmentLabels.get(s.compartiment) ?? null,
      }),
    );

    const covered = new Set(measurementTypes.map((m) => `${m.compartment}|${m.quantity}`));
    const { rows: publishedRows } = await getPool().query<{
      compartiment: string; grootheid: string; eenheid: string | null;
    }>(
      `SELECT compartiment, grootheid, eenheid FROM location_quantities
        WHERE location_code = $1 ORDER BY grootheid`,
      [code.toLowerCase()],
    );

    for (const r of publishedRows) {
      if (covered.has(`${r.compartiment}|${r.grootheid}`)) continue;
      measurementTypes.push({
        // No series row yet, so no id to reference.
        seriesId: -1,
        quantity: r.grootheid,
        quantityLabel: quantityLabels.get(r.grootheid) ?? null,
        compartment: r.compartiment,
        compartmentLabel: compartmentLabels.get(r.compartiment) ?? null,
        unit: r.eenheid,
        procesType: 'meting',
        discriminators: {},
        coverage: { from: null, to: null, points: 0 },
      });
    }

    measurementTypes.sort((a, b) => a.quantity.localeCompare(b.quantity));

    return { ...location, measurementTypes };
  });

  app.get('/api/locations/:code/latest', async (request): Promise<LatestValue[]> => {
    const { code } = request.params as { code: string };
    const location = await getLocation(code);
    if (!location) throw notFound(`No location with code ${code}`);

    const rows = await readLatestForLocation(code);
    return rows.map((r): LatestValue => ({
      code: location.code,
      seriesId: r.seriesId,
      quantity: r.grootheid,
      unit: r.eenheid,
      value: r.value,
      valueText: r.valueText,
      timestamp: r.ts,
      qualityCode: r.qualityCode,
      procesType: r.procesType,
    }));
  });

  app.get('/api/locations/:code/observations', async (request): Promise<ObservationsResponse> => {
    const { code } = request.params as { code: string };
    const q = request.query as Record<string, unknown>;

    const grootheid = parseString(q['grootheid'], 'grootheid', 50);
    if (!grootheid) throw badRequest('grootheid is required');

    const location = await getLocation(code);
    if (!location) throw notFound(`No location with code ${code}`);

    const compartiment = parseString(q['compartiment'], 'compartiment', 50);
    const { from, to } = parseWindow(q);
    const requested = parseResolution(q['resolution']);

    let series = await findSeries(code, grootheid, {
      ...(compartiment ? { compartiment } : {}),
    });

    // Fall back to a live upstream call when the window is not covered locally.
    // Before the Phase 4 backfill has run this is the only source of data; after
    // it, this is the lazy path for quantities that are not eagerly backfilled.
    let upstreamError: string | undefined;
    const needsFetch = !series
      || series.pointCount === 0
      || !series.firstObservedAt
      || !series.lastObservedAt
      || Date.parse(series.firstObservedAt) > from.getTime()
      || Date.parse(series.lastObservedAt) < to.getTime();

    if (needsFetch) {
      const resolvedCompartiment = compartiment ?? series?.compartiment
        ?? await defaultCompartimentFor(code, grootheid);

      if (resolvedCompartiment) {
        const result = await ensureObservations({
          locationCode: code,
          grootheid,
          compartiment: resolvedCompartiment,
          from,
          to,
        });
        upstreamError = result.error;
        if (result.seriesIds.length > 0) {
          series = await findSeries(code, grootheid, {
            ...(compartiment ? { compartiment } : {}),
          });
        }
      }
    }

    if (!series) {
      // Still nothing: either the location does not report this quantity, or
      // upstream is down. Say so explicitly rather than returning a blank chart.
      const { resolution } = selectResolution(from, to, requested);
      if (upstreamError) throw upstreamFailure(`Upstream fetch failed: ${upstreamError}`);
      return {
        code: location.code,
        seriesId: -1,
        quantity: grootheid,
        unit: null,
        procesType: 'meting',
        from: from.toISOString(),
        to: to.toISOString(),
        resolution,
        requestedResolution: requested,
        downsampled: false,
        truncated: false,
        points: [],
        backfillPending: true,
      };
    }

    const { resolution, downsampled } = selectResolution(from, to, requested);

    // Quality filtering happens here, not at ingest: the raw code is always
    // stored. `includeAllQuality=true` opts out of the display filter.
    const includeAll = parseBoolean(q['includeAllQuality'], 'includeAllQuality') ?? false;
    const qualityCodes = includeAll ? null : DISPLAY_QUALITY_CODES;

    let result = await readObservations(
      series.id, from, to, resolution, qualityCodes,
    );

    // Self-heal an unmaterialised aggregate. Raw rows can exist while the
    // hourly/daily view has never been refreshed over their range -- the
    // scheduled policies only cover recent time, and an ingest that failed
    // between committing rows and refreshing leaves exactly this state. Reading
    // it back as an empty chart when the data is right there would be the
    // silent blank chart we are trying to avoid.
    const overlapsCoverage = series.firstObservedAt !== null
      && series.lastObservedAt !== null
      && Date.parse(series.firstObservedAt) <= to.getTime()
      && Date.parse(series.lastObservedAt) >= from.getTime();

    if (resolution !== 'raw' && result.points.length === 0 && overlapsCoverage) {
      await refreshAggregates(from, to);
      result = await readObservations(series.id, from, to, resolution, qualityCodes);
    }

    return {
      code: location.code,
      seriesId: series.id,
      quantity: series.grootheid,
      unit: series.eenheid,
      procesType: series.procesType,
      from: from.toISOString(),
      to: to.toISOString(),
      resolution: result.resolution,
      requestedResolution: requested,
      downsampled,
      truncated: result.truncated,
      points: result.points,
      backfillPending: series.pointCount === 0,
      // Upstream was unreachable, so this window may be incomplete.
      ...(upstreamError ? { stale: true, fetchedAt: new Date().toISOString() } : {}),
    };
  });

  app.get('/api/quantities', async (): Promise<QuantitiesResponse> => {
    const [quantityLabels, compartmentLabels] = await Promise.all([
      loadLabels('grootheid'),
      loadLabels('compartiment'),
    ]);

    const { rows: quantityRows } = await getPool().query<{
      grootheid: string; compartments: string[]; active_locations: number;
    }>(
      `SELECT q.grootheid,
              array_agg(DISTINCT q.compartiment ORDER BY q.compartiment) AS compartments,
              count(DISTINCT q.location_code)::int AS active_locations
         FROM location_quantities q
         JOIN locations l ON l.code = q.location_code AND l.active
        GROUP BY q.grootheid
        ORDER BY q.grootheid`,
    );

    const { rows: compartmentRows } = await getPool().query<{
      compartiment: string; active_locations: number;
    }>(
      `SELECT q.compartiment, count(DISTINCT q.location_code)::int AS active_locations
         FROM location_quantities q
         JOIN locations l ON l.code = q.location_code AND l.active
        GROUP BY q.compartiment
        ORDER BY q.compartiment`,
    );

    return {
      quantities: quantityRows.map((r) => ({
        code: r.grootheid,
        label: quantityLabels.get(r.grootheid) ?? null,
        compartments: r.compartments,
        activeLocations: r.active_locations,
      })),
      compartments: compartmentRows.map((r) => ({
        code: r.compartiment,
        label: compartmentLabels.get(r.compartiment) ?? null,
        activeLocations: r.active_locations,
      })),
    };
  });

  app.get('/api/health', async (reply): Promise<HealthResponse> => {
    const [counts, locationsState, catalogueState, backfill] = await Promise.all([
      locationCounts(),
      getRefreshState('locations'),
      getRefreshState('catalogue'),
      backfillProgress(),
    ]);

    // Report the last known upstream result rather than probing RWS on every
    // health check -- polling a third party from a liveness endpoint is rude.
    const now = new Date();
    const refreshedAt = locationsState?.refreshedAt ?? null;
    const ageSeconds = refreshedAt
      ? Math.round((now.getTime() - Date.parse(refreshedAt)) / 1000)
      : null;

    const stale = ageSeconds === null || ageSeconds > 2 * 86_400;
    const status: HealthResponse['status'] = stale || counts.active === 0 ? 'degraded' : 'ok';

    return {
      status,
      upstream: {
        api: {
          reachable: catalogueState?.succeeded ?? false,
          checkedAt: catalogueState?.refreshedAt ?? now.toISOString(),
          latencyMs: null,
        },
        wfs: {
          reachable: locationsState?.succeeded ?? false,
          checkedAt: refreshedAt ?? now.toISOString(),
          latencyMs: null,
        },
      },
      cache: {
        locationsRefreshedAt: refreshedAt,
        catalogueRefreshedAt: catalogueState?.refreshedAt ?? null,
        ageSeconds,
      },
      locations: counts,
      backfill,
    };
  });

  // Anything that escapes a handler becomes the standard envelope. Unexpected
  // errors are logged in full but reported without internals.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }

    // Plugin errors carry their own status (the rate limiter's 429, a malformed
    // request's 400). Preserve it rather than flattening everything to 500: a
    // throttled client told "500" retries immediately instead of backing off.
    const plugin = error as { statusCode?: number; message?: string };
    if (typeof plugin.statusCode === 'number'
        && plugin.statusCode >= 400 && plugin.statusCode < 500) {
      return reply.status(plugin.statusCode).send({
        error: {
          code: plugin.statusCode === 429 ? 'rate_limited' : 'bad_request',
          message: plugin.message ?? 'Request rejected',
        },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'An unexpected error occurred' },
    });
  });
}

export { config };
