// Seeding helpers shared by the e2e API (api.ts) and the load test's seed (scripts/seed-loadtest.ts), P9b.
// TEST-ONLY, like everything under test/: no image holds it. They return plain SQL text with literals (never a
// bound parameter), so one string runs through a `pg` client and through `psql` in the db container alike. Every
// interpolated value is checked against a closed pattern first; none ever comes from a visitor or a provider.
// No imports: the load test runs the seed script on the bare runner, without `pnpm install`.

const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/;
const STATION = /^[a-z0-9][a-z0-9._-]{0,80}$/;

/** A UTC instant as a SQL literal. */
export function instantLiteral(iso: string): string {
  if (!INSTANT.test(iso)) throw new RangeError('seed: not a UTC instant');
  return `'${iso}'::timestamptz`;
}

function stationLiteral(id: string): string {
  if (!STATION.test(id)) throw new RangeError('seed: not a station id');
  return `'${id}'`;
}

/** The series every public view shows as a primary one: active, public, displayed. */
export const PUBLIC_PRIMARY = `s.active AND e.role = 'primary' AND e.audience = 'public' AND e.lic_display`;

export type ObsSeed = {
  from: string;
  to: string;
  /** This station's values stop at `last` (the e2e's gap station). */
  gap?: { station: string; last: string };
  /** This station gets no regular grid (the e2e's DST station holds hand-picked values). */
  skipStation?: string;
};

/**
 * One synthetic value per expected step in [from, to] for every public primary series (a sine whose phase and level
 * differ a little per series; H in cm, anything else as a discharge). `batch_id` has no foreign key, so 1 does.
 * ON CONFLICT DO NOTHING: a row the loader already holds stays, and a second run adds nothing.
 */
export function obsInsertSql(o: ObsSeed): string {
  const to = o.gap
    ? `CASE WHEN s.station_id = ${stationLiteral(o.gap.station)} THEN ${instantLiteral(o.gap.last)} ELSE ${instantLiteral(o.to)} END`
    : instantLiteral(o.to);
  const skip = o.skipStation ? `AND s.station_id <> ${stationLiteral(o.skipStation)}` : '';
  return `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     SELECT s.id, g,
            CASE s.quantity WHEN 'H' THEN 300 + 40 * sin(extract(epoch FROM g)::float8 / 20000)
                            ELSE 800 + 100 * sin(extract(epoch FROM g)::float8 / 30000) END + s.id % 50,
            1, 1
     FROM series s
     JOIN series_eff e ON e.series_id = s.id
     CROSS JOIN LATERAL generate_series(${instantLiteral(o.from)}, ${to}, s.expected_step) g
     WHERE ${PUBLIC_PRIMARY} ${skip}
     ON CONFLICT DO NOTHING`;
}

/**
 * The hourly or daily rollup of obs (what the loader keeps beside it). With `bound` only the buckets that lie wholly
 * in [from, to) (the caller aligns both to the unit), else every bucket of obs.
 */
export function rollupInsertSql(table: 'obs_1h' | 'obs_1d', bound?: { from: string; to: string }): string {
  const unit = table === 'obs_1h' ? 'hour' : 'day';
  const where = bound ? `WHERE ts >= ${instantLiteral(bound.from)} AND ts < ${instantLiteral(bound.to)}` : '';
  return `INSERT INTO ${table} (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
       SELECT series_id, date_trunc('${unit}', ts, 'UTC'), min(value), max(value), avg(value),
              (array_agg(value ORDER BY ts DESC))[1], count(*), bit_or(qc)
       FROM obs ${where} GROUP BY 1, 2
       ON CONFLICT DO NOTHING`;
}

/** obs_latest (what the latest view reads): the newest of the seeded window per public primary series, only if newer. */
export function latestUpsertSql(from: string, to: string): string {
  return `INSERT INTO obs_latest (series_id, ts, value, qc, batch_id)
       SELECT DISTINCT ON (o.series_id) o.series_id, o.ts, o.value, o.qc, o.batch_id
       FROM obs o
       JOIN series s ON s.id = o.series_id
       JOIN series_eff e ON e.series_id = s.id
       WHERE ${PUBLIC_PRIMARY} AND o.ts >= ${instantLiteral(from)} AND o.ts <= ${instantLiteral(to)}
       ORDER BY o.series_id, o.ts DESC
       ON CONFLICT (series_id) DO UPDATE
         SET ts = EXCLUDED.ts, value = EXCLUDED.value, qc = EXCLUDED.qc, batch_id = EXCLUDED.batch_id
         WHERE EXCLUDED.ts > obs_latest.ts`;
}
