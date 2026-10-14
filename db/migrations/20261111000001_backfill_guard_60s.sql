-- migrate:up

-- The backfill guard pauses the runner sooner (P14a fix). `backlog`: the oldest unread manifest line is older than
-- 60 s (it was 600 s, five times the 120 s freshness limit). `loader_lag`: the loader row is older than 150 s (it was
-- 5 minutes); the health pass rewrites it every 60 to 90 s (about 130 s on the night it runs the nightly jobs), so an
-- older row is a stalled load loop, and the runner no longer goes on from a stale row with a zero backlog. On the
-- first NL-1 night (2026-10-12/13) the runner went on starting chunks while live data was late. Only these two
-- numbers change: the body, SECURITY DEFINER, the search_path, the owner, the REVOKE and the GRANT to rws_backfill
-- (CREATE OR REPLACE keeps them) stay as in 20261110000001_backfill.sql.
CREATE OR REPLACE FUNCTION backfill_guard(p_source text) RETURNS text
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
