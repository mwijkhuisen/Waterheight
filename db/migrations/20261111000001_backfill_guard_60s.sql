-- migrate:up

-- The backfill guard's backlog limit goes from 600 s to 60 s (P14a fix). The guard reads the loader row that the
-- health pass writes once a minute, so the row it sees can be 60 s old; a backlog limit of 60 s keeps live lag under
-- the 120 s freshness limit. 600 s was five times that limit, so the runner went on starting chunks while live data
-- was already late (the first NL-1 night, 2026-10-12/13). Only the number changes: the body, SECURITY DEFINER, the
-- search_path, the owner, the REVOKE and the GRANT to rws_backfill (CREATE OR REPLACE keeps them) stay as in
-- 20261110000001_backfill.sql.
CREATE OR REPLACE FUNCTION backfill_guard(p_source text) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN l.value IS NULL
      OR COALESCE((l.value ->> 'computed_at')::timestamptz, '-infinity') < now() - interval '5 minutes' THEN 'loader_lag'
    WHEN COALESCE((l.value ->> 'backlog_age_s')::numeric, 0) > 60
      OR COALESCE((l.value ->> 'backlog_files')::numeric, 0) > 3 THEN 'backlog'
    WHEN EXISTS (
        SELECT 1 FROM public.backfill_job j
        WHERE j.source_id = p_source
          AND j.status IN ('planned', 'running', 'paused')
          AND j.chunks_with_data - (SELECT count(*) FROM public.backfill_chunk c WHERE c.job_id = j.id) > 30
      ) THEN 'unloaded'
    WHEN h.status IS DISTINCT FROM 'ok' THEN 'stale'
    ELSE 'ok'
  END
  FROM (SELECT 1) AS one
  LEFT JOIN public.app_meta l ON l.key = 'loader'
  LEFT JOIN public.source_health h ON h.source_id = p_source
$$;

-- migrate:down

CREATE OR REPLACE FUNCTION backfill_guard(p_source text) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN l.value IS NULL
      OR COALESCE((l.value ->> 'computed_at')::timestamptz, '-infinity') < now() - interval '5 minutes' THEN 'loader_lag'
    WHEN COALESCE((l.value ->> 'backlog_age_s')::numeric, 0) > 600
      OR COALESCE((l.value ->> 'backlog_files')::numeric, 0) > 3 THEN 'backlog'
    WHEN EXISTS (
        SELECT 1 FROM public.backfill_job j
        WHERE j.source_id = p_source
          AND j.status IN ('planned', 'running', 'paused')
          AND j.chunks_with_data - (SELECT count(*) FROM public.backfill_chunk c WHERE c.job_id = j.id) > 30
      ) THEN 'unloaded'
    WHEN h.status IS DISTINCT FROM 'ok' THEN 'stale'
    ELSE 'ok'
  END
  FROM (SELECT 1) AS one
  LEFT JOIN public.app_meta l ON l.key = 'loader'
  LEFT JOIN public.source_health h ON h.source_id = p_source
$$;
