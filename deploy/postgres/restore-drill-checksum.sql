-- The restore drill's checksum (deploy/bin/rws-restore-drill, P12b, plan A8): the P2 md5 per source and month
-- (computeChecksums in apps/server/src/load/health.ts, SAME_AUDIENCE inlined) restricted to the observations of one
-- UTC day, psql variable `day` (YYYY-MM-DD). psql runs it inside the drill's throwaway PostgreSQL, from stdin.
-- test/restore-drill-sql.test.ts keeps the expression equal to health.ts's; change both together.
SELECT s.source_id, to_char(date_trunc('month', o.ts AT TIME ZONE 'UTC'), 'YYYY-MM') AS partition,
       md5(string_agg(s.provider_key || '|' || (extract(epoch FROM o.ts))::bigint || '|' || o.value::text || '|' || o.qc,
                      ',' ORDER BY s.provider_key, o.ts)) AS md5,
       count(*)::int AS rows
FROM obs o
JOIN series s ON s.id = o.series_id
JOIN source src ON src.id = s.source_id
WHERE COALESCE(s.audience, src.audience) = src.audience
  AND o.ts >= (:'day' || ' 00:00:00+00')::timestamptz AND o.ts < (:'day' || ' 00:00:00+00')::timestamptz + interval '1 day'
GROUP BY 1, 2
ORDER BY 1, 2;
