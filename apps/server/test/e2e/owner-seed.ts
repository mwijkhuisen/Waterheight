// P10a (C19): synthetic owner-only rows for the owner e2e, on BASE TABLES (never a view), at the fixed e2e clock.
// Every value is made up (invariant 9, 11); the registry sync already wrote the owner series and the real
// `private_basis`. Called only when E2E_OWNER_PUBLISH_DIR is set.
import type { Client } from 'pg';
import { XSS } from './public-seed.ts';

export const OWNER_STATION = 'be.spw.1046';
export const LU_STATION = 'lu.age.bigonville';
/** The owner source whose private_basis clause holds the XSS string (the banner test compares the others to the registry). */
export const XSS_SOURCE = 'LU-3';

export async function seedOwner(admin: Client, from: string, now: string): Promise<void> {
  // One BE-3 H series with a value per step (owner audience by its source: only the owner views show it).
  const obs = await admin.query(
    `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     SELECT s.id, g, 250 + 30 * sin(extract(epoch FROM g)::float8 / 20000), 1, 1
     FROM series s, LATERAL generate_series($2::timestamptz, $3::timestamptz, s.expected_step) g
     WHERE s.station_id = $1 AND s.quantity = 'H' AND s.role = 'primary'
     ON CONFLICT DO NOTHING`,
    [OWNER_STATION, from, now],
  );
  if ((obs.rowCount ?? 0) === 0) throw new Error(`seed: no BE-3 H series on ${OWNER_STATION}`);

  // An LU-3 forecast run with a 10-90 % band, NOW - 1 h .. NOW + 24 h, on an LU-1 H series.
  const run = await admin.query(
    `WITH run AS (
       INSERT INTO forecast_run (series_id, source_id, issued_at, issued_inferred, first_valid, last_valid, fetched_at,
                                 content_hash, kind, step, provider_segment_end)
       SELECT s.id, 'LU-3', $2::timestamptz - interval '1 hour', false, $2::timestamptz - interval '1 hour',
              $2::timestamptz + interval '24 hours', $2::timestamptz - interval '1 hour', decode(md5('e2e-lu3'), 'hex'),
              'quantiles', interval '1 hour', NULL
       FROM series s WHERE s.station_id = $1 AND s.quantity = 'H' AND s.role = 'primary'
       RETURNING id)
     INSERT INTO forecast_value (run_id, valid_ts, value, p10, p90, flags)
     SELECT run.id, g, v, v - 15, v + 20, 0
     FROM run, generate_series($2::timestamptz - interval '1 hour', $2::timestamptz + interval '24 hours', interval '1 hour') g,
          LATERAL (SELECT (300 + 2 * extract(epoch FROM g - $2::timestamptz) / 3600)::real AS v) x`,
    [LU_STATION, now],
  );
  if ((run.rowCount ?? 0) === 0) throw new Error(`seed: no LU-1 H series on ${LU_STATION}`);

  // An LU-4 orange threshold on the same series (owner rows; the public views drop LU-4 by source).
  await admin.query(
    `INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, priority, basis_label, valid)
     SELECT id, 'LU-4', 'LU4_ORANGE', 450, 'cm', 'operational', 0, 'e2e orange', tstzrange('2020-01-01Z', NULL)
     FROM series WHERE station_id = $1 AND quantity = 'H' AND role = 'primary'`,
    [LU_STATION],
  );

  // The banner's clause as hostile text; the JSON shape the registry sync wrote stays (clause, url, retrieved).
  const basis = await admin.query(
    `UPDATE source SET private_basis = jsonb_set(private_basis, '{clause}', to_jsonb($2::text)) WHERE id = $1`,
    [XSS_SOURCE, `Personal use only ${XSS}`],
  );
  if (basis.rowCount !== 1) throw new Error(`seed: no owner source ${XSS_SOURCE}`);

  // The health of the six personal-use sources (the canary has none), so that the owner site's Status page lists them
  // and the public one counts them (`ownerSources`, which no spec pins): a mix of states, last fetch at NOW.
  const health: [source: string, status: 'ok' | 'degraded' | 'down', failures: number][] = [
    ['BE-3', 'ok', 0],
    ['LU-2', 'ok', 0],
    ['LU-3', 'ok', 0],
    ['LU-4', 'degraded', 1],
    ['DE-2', 'ok', 0],
    ['DE-3', 'down', 5],
  ];
  for (const [source, status, failures] of health) {
    const done = await admin.query(
      `INSERT INTO source_health (source_id, last_fetch_ok, newest_ts, consecutive_failures, status)
       VALUES ($1, $2::timestamptz, $2::timestamptz - interval '10 minutes', $3, $4)
       ON CONFLICT (source_id) DO UPDATE
         SET last_fetch_ok = EXCLUDED.last_fetch_ok, newest_ts = EXCLUDED.newest_ts,
             consecutive_failures = EXCLUDED.consecutive_failures, status = EXCLUDED.status`,
      [source, now, failures, status],
    );
    if (done.rowCount !== 1) throw new Error(`seed: no health row for ${source}`);
  }
}
