import type pg from 'pg';

// Synthetic history for the climatology tests (P14f): hourly observations, a yearly sine with a deterministic jitter, so
// every day key has P10 < P90. Owner-audience series get synthetic values only (invariants 9 and 11).

/** Hourly values of [from, to) (UTC instants) for `series`: base + amp·sin(doy) + a jitter of ± amp/4, qc 1. */
export async function seedHourly(
  admin: pg.Client,
  series: number,
  range: { from: string; to: string },
  shape: { base: number; amp: number },
): Promise<void> {
  await admin.query(
    `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     SELECT $1, g,
            ($2::float8 + $3::float8 * sin(2 * pi() * extract(doy FROM g) / 366.0)
               + ((hashint8(extract(epoch FROM g)::bigint) & 1023) / 1023.0 - 0.5) * $3::float8 * 0.5)::real,
            1, 1
     FROM generate_series($4::timestamptz, $5::timestamptz - interval '1 hour', interval '1 hour') g`,
    [series, shape.base, shape.amp, range.from, range.to],
  );
}

/** The open DOY rows of a series: kind, day key, value (a float4, as stored). */
export async function doyRows(admin: pg.Client, series: number) {
  const { rows } = await admin.query<{ kind: string; md: number; value: number }>(
    `SELECT kind, season_from_md AS md, value FROM reference_value
     WHERE series_id = $1 AND kind IN ('P10_DOY', 'P90_DOY') AND upper_inf(valid) ORDER BY kind, season_from_md`,
    [series],
  );
  return rows;
}
