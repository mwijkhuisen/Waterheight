-- migrate:up

-- P14b: the backfill guard takes the source whose series a spec writes (DE-8 → DE-7, FR-2 → FR-1, CH-9 → CH-1). The
-- loader's verdicts (`loader_lag`, `backlog`, `unloaded`) stay on the job's own source, `p_source`; `stale` judges
-- the target's health, COALESCE(p_target, p_source), because DE-8, FR-2 and CH-9 have no live series of their own
-- (a source_health row that is missing or not `ok`, `unknown` included, is `stale`, never ok). A one-argument call
-- (NL-1, the P14a runner) is the same function through the DEFAULT. The body, the verdict order, SECURITY DEFINER,
-- the search_path and the owner are as in 20261112000001_backfill_guard_unloaded.sql; a new signature is a new
-- function, so the REVOKE from PUBLIC and the GRANT to rws_backfill of 20261110000001_backfill.sql are repeated.
DROP FUNCTION backfill_guard(text);

CREATE FUNCTION backfill_guard(p_source text, p_target text DEFAULT NULL) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN l.value IS NULL
      OR COALESCE((l.value ->> 'computed_at')::timestamptz, '-infinity') < now() - interval '150 seconds' THEN 'loader_lag'
    WHEN COALESCE((l.value ->> 'backlog_age_s')::numeric, 0) > 60
      OR COALESCE((l.value ->> 'backlog_files')::numeric, 0) > 3 THEN 'backlog'
    WHEN EXISTS (
        SELECT 1 FROM public.backfill_job j
        WHERE j.source_id = p_source
          AND j.status IN ('planned', 'running', 'paused')
          AND j.chunks_with_data - (SELECT count(DISTINCT c.chunk_from) FROM public.backfill_chunk c WHERE c.job_id = j.id) > 0
      ) THEN 'unloaded'
    WHEN h.status IS DISTINCT FROM 'ok' THEN 'stale'
    ELSE 'ok'
  END
  FROM (SELECT 1) AS one
  LEFT JOIN public.app_meta l ON l.key = 'loader'
  LEFT JOIN public.source_health h ON h.source_id = COALESCE(p_target, p_source)
$$;

REVOKE ALL ON FUNCTION backfill_guard(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backfill_guard(text, text) TO rws_backfill;

-- migrate:down

DROP FUNCTION backfill_guard(text, text);

CREATE FUNCTION backfill_guard(p_source text) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN l.value IS NULL
      OR COALESCE((l.value ->> 'computed_at')::timestamptz, '-infinity') < now() - interval '150 seconds' THEN 'loader_lag'
    WHEN COALESCE((l.value ->> 'backlog_age_s')::numeric, 0) > 60
      OR COALESCE((l.value ->> 'backlog_files')::numeric, 0) > 3 THEN 'backlog'
    WHEN EXISTS (
        SELECT 1 FROM public.backfill_job j
        WHERE j.source_id = p_source
          AND j.status IN ('planned', 'running', 'paused')
          AND j.chunks_with_data - (SELECT count(DISTINCT c.chunk_from) FROM public.backfill_chunk c WHERE c.job_id = j.id) > 0
      ) THEN 'unloaded'
    WHEN h.status IS DISTINCT FROM 'ok' THEN 'stale'
    ELSE 'ok'
  END
  FROM (SELECT 1) AS one
  LEFT JOIN public.app_meta l ON l.key = 'loader'
  LEFT JOIN public.source_health h ON h.source_id = p_source
$$;

REVOKE ALL ON FUNCTION backfill_guard(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backfill_guard(text) TO rws_backfill;
