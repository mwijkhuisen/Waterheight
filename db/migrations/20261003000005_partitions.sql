-- migrate:up

-- Monthly partitions of obs (on ts) and forecast_value (on valid_ts) for every
-- UTC month that [p_from, p_to] touches. The loader calls it for each batch's
-- range and nightly (three months ahead); `migrate` calls it at deploy time.
--
-- SECURITY DEFINER, because rws_load does not own the tables. Therefore: a
-- fixed search_path with pg_temp last (a temporary object can never shadow a
-- name), every name schema-qualified and built with %I, a bounded range, and
-- EXECUTE only for the roles named below. A new partition is built beside the
-- parent and then attached, which does not block readers of the parent.
CREATE FUNCTION ensure_partitions(p_from timestamptz, p_to timestamptz) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  month_start timestamp;
  month_end   timestamp;
  last_month  timestamp;
  parents     CONSTANT text[] := ARRAY['obs', 'forecast_value'];
  columns     CONSTANT text[] := ARRAY['ts', 'valid_ts'];
  parent      text;
  col         text;
  part        text;
  lo          timestamptz;
  hi          timestamptz;
  created     int := 0;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'ensure_partitions: bad range' USING ERRCODE = '22023';
  END IF;
  IF p_from < timestamptz '2000-01-01 00:00:00+00'
     OR p_to > now() + interval '400 days'
     OR p_to - p_from > interval '3700 days' THEN
    RAISE EXCEPTION 'ensure_partitions: range outside the partition horizon' USING ERRCODE = '22023';
  END IF;

  month_start := date_trunc('month', p_from AT TIME ZONE 'UTC');
  last_month  := date_trunc('month', p_to AT TIME ZONE 'UTC');
  WHILE month_start <= last_month LOOP
    month_end := month_start + interval '1 month';
    lo := month_start AT TIME ZONE 'UTC';
    hi := month_end AT TIME ZONE 'UTC';
    FOR i IN 1 .. 2 LOOP
      parent := parents[i];
      col := columns[i];
      part := parent || '_' || to_char(month_start, 'YYYY_MM');
      IF to_regclass(format('public.%I', part)) IS NULL THEN
        EXECUTE format(
          'CREATE TABLE public.%I (LIKE public.%I INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)',
          part, parent);
        -- The matching CHECK lets ATTACH skip its validation scan.
        EXECUTE format(
          'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I >= %L AND %I < %L)',
          part, part || '_bounds', col, lo, col, hi);
        EXECUTE format(
          'ALTER TABLE public.%I ATTACH PARTITION public.%I FOR VALUES FROM (%L) TO (%L)',
          parent, part, lo, hi);
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', part, part || '_bounds');
        created := created + 1;
      END IF;
    END LOOP;
    month_start := month_end;
  END LOOP;
  RETURN created;
END
$$;

-- migrate:down

DROP FUNCTION ensure_partitions(timestamptz, timestamptz);
