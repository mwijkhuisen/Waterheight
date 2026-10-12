-- migrate:up

-- Backfill (P14a): obs gets YEARLY partitions before the epoch year. Twenty years
-- of NL-1 history in monthly partitions would be hundreds of tables for the
-- planner; yearly ones keep the count small and still prune.
--
--   * Constant boundary 2026-01-01T00:00:00Z. Below it, obs gets obs_yYYYY =
--     [YYYY-01-01, YYYY+1-01-01), whole years only, so the result does not depend
--     on the order or the ranges of the calls. From the boundary on, the monthly
--     code below is the one of 20261003000005_partitions.sql, unchanged.
--   * forecast_value never gets a partition below the boundary (no yearlies, and
--     no monthlies there either: the 2000-01-01 floor of the old function is now
--     "nothing below 2026"), so an insert there fails loudly (23514). A call whose
--     range starts below the boundary makes the obs yearlies and, from the
--     boundary on, both tables' months.
--   * Lower bound 1900-01-01 for obs. The 3700-day span guard applies to the
--     monthly part [max(p_from, boundary), p_to] only; the yearly part is at
--     most 126 tables.
--   * Before the first yearly partition is made, the function reads the partition
--     tree of obs and refuses (55000) if a MONTHLY partition lies below the
--     boundary: a yearly one beside it could overlap, and a mixed layout is a
--     decision for a human (partition-maintenance.md), not for a loader.
--   * Still no default partition, SECURITY DEFINER, fixed search_path, the same
--     grants (CREATE OR REPLACE keeps them).
CREATE OR REPLACE FUNCTION ensure_partitions(p_from timestamptz, p_to timestamptz) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  boundary    CONSTANT timestamptz := timestamptz '2026-01-01 00:00:00+00';
  month_start timestamp;
  month_end   timestamp;
  last_month  timestamp;
  year_start  timestamp;
  last_year   timestamp;
  m_from      timestamptz;
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
  IF p_from < timestamptz '1900-01-01 00:00:00+00' OR p_to > now() + interval '400 days' THEN
    RAISE EXCEPTION 'ensure_partitions: range outside the partition horizon' USING ERRCODE = '22023';
  END IF;
  IF p_to >= boundary AND p_to - greatest(p_from, boundary) > interval '3700 days' THEN
    RAISE EXCEPTION 'ensure_partitions: range outside the partition horizon' USING ERRCODE = '22023';
  END IF;

  IF p_from < boundary THEN
    -- A monthly obs partition below the boundary: refuse before creating anything.
    IF EXISTS (
      SELECT 1
      FROM pg_partition_tree('public.obs'::regclass) pt
      JOIN pg_class c ON c.oid = pt.relid
      CROSS JOIN LATERAL regexp_match(
        pg_get_expr(c.relpartbound, c.oid), 'FROM \(''([^'']+)''\) TO \(''([^'']+)''\)') AS b(m)
      WHERE pt.isleaf AND b.m IS NOT NULL
        AND b.m[2]::timestamptz <= boundary
        AND b.m[2]::timestamptz <> ((b.m[1]::timestamptz AT TIME ZONE 'UTC') + interval '1 year') AT TIME ZONE 'UTC'
    ) THEN
      RAISE EXCEPTION 'ensure_partitions: a monthly obs partition exists below the yearly boundary'
        USING ERRCODE = '55000';
    END IF;

    year_start := date_trunc('year', p_from AT TIME ZONE 'UTC');
    last_year  := date_trunc('year', least(p_to, boundary - interval '1 microsecond') AT TIME ZONE 'UTC');
    WHILE year_start <= last_year LOOP
      lo := year_start AT TIME ZONE 'UTC';
      hi := (year_start + interval '1 year') AT TIME ZONE 'UTC';
      part := 'obs_y' || to_char(year_start, 'YYYY');
      IF to_regclass(format('public.%I', part)) IS NULL THEN
        EXECUTE format(
          'CREATE TABLE public.%I (LIKE public.obs INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)',
          part);
        -- The matching CHECK lets ATTACH skip its validation scan.
        EXECUTE format(
          'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (ts >= %L AND ts < %L)',
          part, part || '_bounds', lo, hi);
        EXECUTE format(
          'ALTER TABLE public.obs ATTACH PARTITION public.%I FOR VALUES FROM (%L) TO (%L)',
          part, lo, hi);
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', part, part || '_bounds');
        created := created + 1;
      END IF;
      year_start := year_start + interval '1 year';
    END LOOP;
  END IF;

  IF p_to >= boundary THEN
    m_from := greatest(p_from, boundary);
    month_start := date_trunc('month', m_from AT TIME ZONE 'UTC');
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
  END IF;
  RETURN created;
END
$$;

-- migrate:down

-- Back to the monthly-only body of 20261003000005_partitions.sql. The yearly
-- partitions, if any were made, stay (data is never dropped by a down).
CREATE OR REPLACE FUNCTION ensure_partitions(p_from timestamptz, p_to timestamptz) RETURNS int
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
