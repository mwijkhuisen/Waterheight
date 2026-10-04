import { createHash } from 'node:crypto';
import { CANARIES } from '@rws/contracts';
import { sql } from 'kysely';
import type { Tx } from './store.ts';

// P9a, task 5: the owner canary is loaded in production (invariant 11: `777777.777` must appear in every owner output
// and nowhere public). For each registry source with `canary: true` and audience `owner` (CANARY-OWNER), `migrate`
// keeps one station, one stage series, one observation (with obs_latest and both rollups), one reference and one
// forecast run with one value, all with fixed keys and inserted only when missing, so a second run changes nothing.
// The series' staleness limit of 100 years carries the observation into every owner snapshot (LOCF) and the run's
// end in 2100 keeps it current in every owner forecast/latest.json; the public family never sees either (the views
// filter by the source's audience). The rows are code, not registry YAML: syncRegistry stays registry-only, and it
// deactivates series only of sources that have station rows, which the canary source has none of.

export const CANARY_STATION = 'nl.canary.owner';
export const CANARY_KEY = 'owner-canary';
/** The canary's one instant: its observation, its rollup buckets, its run's issue time and first valid time. */
export const CANARY_AT = '2026-10-01T00:00:00Z';
const RUN_END = '2100-01-01T00:00:00Z';
/** obs.batch_id has no foreign key: the canary's rows name no batch. */
const NO_BATCH = 0;

/** Returns how many canary sources it kept. Runs inside migrate's transaction, under the loader lock. */
export async function syncOwnerCanary(tx: Tx): Promise<number> {
  const { rows: sources } = await sql<{ id: string }>`
    SELECT id FROM source WHERE canary AND audience = 'owner' ORDER BY id`.execute(tx);
  const value = CANARIES.owner.value;
  for (const { id: source } of sources) {
    await sql`
      INSERT INTO station (id, name, country, tier) VALUES (${CANARY_STATION}, 'Owner canary', 'NL', 2)
      ON CONFLICT (id) DO NOTHING`.execute(tx);
    const { rows } = await sql<{ id: number }>`
      INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                          native_step, expected_step, staleness_limit, role, active)
      VALUES (${CANARY_STATION}, ${source}, 'H', 'stage', ${CANARY_KEY}, 'cm', 1, 'LOCAL', '1 hour', '1 hour',
              '36500 days', 'primary', true)
      ON CONFLICT (source_id, provider_key) DO UPDATE SET active = true
      RETURNING id`.execute(tx);
    const series = (rows[0] as { id: number }).id;
    await sql`SELECT ensure_partitions(${CANARY_AT}::timestamptz, ${CANARY_AT}::timestamptz)`.execute(tx);
    await sql`
      INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES (${series}, ${CANARY_AT}, ${value}, 0, ${NO_BATCH})
      ON CONFLICT (series_id, ts) DO NOTHING`.execute(tx);
    await sql`
      INSERT INTO obs_latest (series_id, ts, value, qc, batch_id)
      VALUES (${series}, ${CANARY_AT}, ${value}, 0, ${NO_BATCH})
      ON CONFLICT (series_id) DO NOTHING`.execute(tx);
    for (const table of ['obs_1h', 'obs_1d'] as const) {
      await sql`
        INSERT INTO ${sql.table(table)} (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
        VALUES (${series}, ${CANARY_AT}, ${value}, ${value}, ${value}, ${value}, 1, 0)
        ON CONFLICT (series_id, bucket) DO NOTHING`.execute(tx);
    }
    // reference_value's key is a temporal one (WITHOUT OVERLAPS), so no ON CONFLICT target: insert when missing.
    await sql`
      INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, valid)
      SELECT ${series}, ${source}, 'CANARY', ${value}, 'cm', 'operational', tstzrange(${CANARY_AT}::timestamptz, NULL)
      WHERE NOT EXISTS (
        SELECT 1 FROM reference_value WHERE series_id = ${series} AND source_id = ${source} AND kind = 'CANARY')`.execute(
      tx,
    );
    const hash = createHash('sha256').update(`${source}/${CANARY_KEY}`).digest();
    await sql`
      INSERT INTO forecast_run (series_id, source_id, issued_at, issued_inferred, first_valid, last_valid, fetched_at,
                                content_hash, kind)
      VALUES (${series}, ${source}, ${CANARY_AT}, false, ${CANARY_AT}, ${RUN_END}, ${CANARY_AT}, ${hash},
              'deterministic')
      ON CONFLICT (series_id, first_valid, content_hash) DO NOTHING`.execute(tx);
    await sql`
      INSERT INTO forecast_value (run_id, valid_ts, value)
      SELECT r.id, r.first_valid, ${value} FROM forecast_run r
      WHERE r.series_id = ${series} AND r.first_valid = ${CANARY_AT}::timestamptz AND r.content_hash = ${hash}
      ON CONFLICT (run_id, valid_ts) DO NOTHING`.execute(tx);
  }
  return sources.length;
}
