

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


--
-- Name: audience; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.audience AS ENUM (
    'off',
    'owner',
    'public'
);


--
-- Name: ensure_partitions(timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_partitions(p_from timestamp with time zone, p_to timestamp with time zone) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
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


--
-- Name: own_obs_at(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.own_obs_at(p_t timestamp with time zone) RETURNS TABLE(series_id integer, ts timestamp with time zone, value real, qc smallint)
    LANGUAGE sql STABLE SECURITY DEFINER ROWS 3000
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET "TimeZone" TO 'UTC'
    AS $$
  SELECT e.series_id, o.ts, o.value, o.qc
  FROM public.series_eff e
  JOIN public.series s ON s.id = e.series_id
  CROSS JOIN LATERAL (
    SELECT o.ts, o.value, o.qc
    FROM public.obs o
    WHERE o.series_id = e.series_id AND o.ts <= p_t AND o.ts > p_t - s.staleness_limit
      AND (e.lic_history_export OR o.ts >= now() - e.history_window)
    ORDER BY o.ts DESC
    LIMIT 1) o
  WHERE s.active AND e.audience IN ('public', 'owner') AND e.role = 'primary' AND e.lic_display
$$;


--
-- Name: pub_obs_at(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pub_obs_at(p_t timestamp with time zone) RETURNS TABLE(series_id integer, ts timestamp with time zone, value real, qc smallint)
    LANGUAGE sql STABLE SECURITY DEFINER ROWS 3000
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET "TimeZone" TO 'UTC'
    AS $$
  SELECT e.series_id, o.ts, o.value, o.qc
  FROM public.series_eff e
  JOIN public.series s ON s.id = e.series_id
  CROSS JOIN LATERAL (
    SELECT o.ts, o.value, o.qc
    FROM public.obs o
    WHERE o.series_id = e.series_id AND o.ts <= p_t AND o.ts > p_t - s.staleness_limit
      AND (e.lic_history_export OR o.ts >= now() - e.history_window)
    ORDER BY o.ts DESC
    LIMIT 1) o
  WHERE s.active AND e.audience IN ('public') AND e.role = 'primary' AND e.lic_display
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: app_meta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_meta (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: attribution; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attribution (
    source_id text NOT NULL,
    ord smallint NOT NULL,
    lang text,
    text text NOT NULL,
    url text,
    needs_date boolean NOT NULL,
    date_kind text,
    logo_allowed boolean,
    required boolean NOT NULL,
    CONSTRAINT attribution_check CHECK ((needs_date = (date_kind IS NOT NULL))),
    CONSTRAINT attribution_date_kind_check CHECK ((date_kind = ANY (ARRAY['retrieval'::text, 'update'::text, 'stand'::text, 'reference'::text]))),
    CONSTRAINT attribution_lang_check CHECK ((lang = ANY (ARRAY['nl'::text, 'en'::text, 'de'::text, 'fr'::text]))),
    CONSTRAINT attribution_ord_check CHECK ((ord >= 0))
);


--
-- Name: class_obs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.class_obs (
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    ts timestamp with time zone NOT NULL,
    source_id text NOT NULL,
    provider_code text,
    provider_label text,
    level_norm smallint,
    batch_id bigint,
    CONSTRAINT class_obs_subject_type_check CHECK ((subject_type = ANY (ARRAY['station'::text, 'area'::text])))
);


--
-- Name: forecast_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forecast_run (
    id bigint NOT NULL,
    series_id integer NOT NULL,
    source_id text NOT NULL,
    issued_at timestamp with time zone,
    issued_inferred boolean DEFAULT false NOT NULL,
    first_valid timestamp with time zone NOT NULL,
    last_valid timestamp with time zone NOT NULL,
    fetched_at timestamp with time zone NOT NULL,
    content_hash bytea NOT NULL,
    kind text NOT NULL,
    step interval,
    provider_segment_end timestamp with time zone,
    batch_id bigint,
    CONSTRAINT forecast_run_check CHECK ((last_valid >= first_valid)),
    CONSTRAINT forecast_run_kind_check CHECK ((kind = ANY (ARRAY['deterministic'::text, 'quantiles'::text, 'ensemble_summary'::text])))
);


--
-- Name: forecast_run_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.forecast_run ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.forecast_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: forecast_value; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forecast_value (
    run_id bigint NOT NULL,
    valid_ts timestamp with time zone NOT NULL,
    value real,
    p05 real,
    p10 real,
    p25 real,
    p50 real,
    p75 real,
    p90 real,
    p95 real,
    vmin real,
    vmax real,
    flags smallint DEFAULT 0 NOT NULL
)
PARTITION BY RANGE (valid_ts);


--
-- Name: gauge_zero; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gauge_zero (
    series_id integer NOT NULL,
    value_m double precision NOT NULL,
    datum text NOT NULL,
    valid tstzrange NOT NULL,
    batch_id bigint NOT NULL,
    CONSTRAINT gauge_zero_datum_check CHECK ((datum = ANY (ARRAY['NAP'::text, 'TAW'::text, 'DNG'::text, 'NHN'::text, 'NN'::text, 'IGN69'::text, 'NGF1884'::text, 'LN02'::text, 'NG95'::text, 'LOCAL'::text, 'MSL'::text]))),
    CONSTRAINT gauge_zero_valid_check CHECK ((NOT isempty(valid)))
);


--
-- Name: ingest_batch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingest_batch (
    id bigint NOT NULL,
    source_id text NOT NULL,
    spec_id text NOT NULL,
    archive_key text NOT NULL,
    sha256 text,
    fetched_at timestamp with time zone NOT NULL,
    http_status smallint,
    bytes bigint,
    adapter_version integer NOT NULL,
    parse_status text NOT NULL,
    n_rows integer DEFAULT 0 NOT NULL,
    n_new integer DEFAULT 0 NOT NULL,
    n_changed integer DEFAULT 0 NOT NULL,
    n_skipped integer DEFAULT 0 NOT NULL,
    error text,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ingest_batch_error_check CHECK ((error ~ '^[a-z0-9_]{1,40}( at [A-Za-z0-9_.?\[\]-]{1,120})?$'::text)),
    CONSTRAINT ingest_batch_n_skipped_check CHECK ((n_skipped >= 0)),
    CONSTRAINT ingest_batch_parse_status_check CHECK ((parse_status = ANY (ARRAY['ok'::text, 'quarantined'::text, 'skipped'::text]))),
    CONSTRAINT ingest_batch_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT ingest_batch_spec_id_check CHECK ((spec_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))
);


--
-- Name: ingest_batch_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ingest_batch ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.ingest_batch_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: load_cursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.load_cursor (
    manifest_file text NOT NULL,
    byte_offset bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT load_cursor_byte_offset_check CHECK ((byte_offset >= 0)),
    CONSTRAINT load_cursor_manifest_file_check CHECK ((manifest_file ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.jsonl$'::text))
);


--
-- Name: obs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.obs (
    series_id integer NOT NULL,
    ts timestamp with time zone NOT NULL,
    value real NOT NULL,
    qc smallint DEFAULT 0 NOT NULL,
    batch_id bigint NOT NULL,
    CONSTRAINT obs_qc_check CHECK (((qc >= 0) AND (qc <= 1023))),
    CONSTRAINT obs_value_check CHECK (((value <> 'NaN'::real) AND (abs(value) <> 'Infinity'::real)))
)
PARTITION BY RANGE (ts);


--
-- Name: obs_1d; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.obs_1d (
    series_id integer CONSTRAINT obs_1h_series_id_not_null NOT NULL,
    bucket timestamp with time zone CONSTRAINT obs_1h_bucket_not_null NOT NULL,
    vmin real CONSTRAINT obs_1h_vmin_not_null NOT NULL,
    vmax real CONSTRAINT obs_1h_vmax_not_null NOT NULL,
    vavg real CONSTRAINT obs_1h_vavg_not_null NOT NULL,
    vlast real CONSTRAINT obs_1h_vlast_not_null NOT NULL,
    n integer CONSTRAINT obs_1h_n_not_null NOT NULL,
    qc_or smallint CONSTRAINT obs_1h_qc_or_not_null NOT NULL,
    CONSTRAINT obs_1h_n_check CHECK ((n > 0))
);


--
-- Name: obs_1h; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.obs_1h (
    series_id integer NOT NULL,
    bucket timestamp with time zone NOT NULL,
    vmin real NOT NULL,
    vmax real NOT NULL,
    vavg real NOT NULL,
    vlast real NOT NULL,
    n integer NOT NULL,
    qc_or smallint NOT NULL,
    CONSTRAINT obs_1h_n_check CHECK ((n > 0))
);


--
-- Name: obs_latest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.obs_latest (
    series_id integer NOT NULL,
    ts timestamp with time zone NOT NULL,
    value real NOT NULL,
    qc smallint NOT NULL,
    batch_id bigint NOT NULL
);


--
-- Name: obs_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.obs_revision (
    series_id integer NOT NULL,
    ts timestamp with time zone NOT NULL,
    old_value real NOT NULL,
    new_value real NOT NULL,
    old_qc smallint NOT NULL,
    new_qc smallint NOT NULL,
    batch_id bigint NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: series; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.series (
    id integer NOT NULL,
    station_id text NOT NULL,
    source_id text NOT NULL,
    quantity text NOT NULL,
    value_kind text,
    provider_key text NOT NULL,
    native_unit text NOT NULL,
    to_canonical double precision NOT NULL,
    datum text,
    native_step interval NOT NULL,
    expected_step interval NOT NULL,
    staleness_limit interval NOT NULL,
    lic_override jsonb,
    audience public.audience,
    role text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone,
    CONSTRAINT series_check CHECK (((quantity = 'Q'::text) = (value_kind IS NULL))),
    CONSTRAINT series_check1 CHECK (((quantity = 'Q'::text) OR (datum IS NOT NULL))),
    CONSTRAINT series_datum_check CHECK ((datum = ANY (ARRAY['NAP'::text, 'TAW'::text, 'DNG'::text, 'NHN'::text, 'NN'::text, 'IGN69'::text, 'NGF1884'::text, 'LN02'::text, 'NG95'::text, 'LOCAL'::text, 'MSL'::text]))),
    CONSTRAINT series_expected_step_check CHECK ((expected_step > '00:00:00'::interval)),
    CONSTRAINT series_lic_override_shape CHECK (((lic_override IS NULL) OR ((jsonb_typeof(lic_override) = 'object'::text) AND ((lic_override - ARRAY['display'::text, 'api'::text, 'bulk_export'::text, 'history_export'::text]) = '{}'::jsonb) AND ((NOT (lic_override ? 'display'::text)) OR (jsonb_typeof((lic_override -> 'display'::text)) = 'boolean'::text)) AND ((NOT (lic_override ? 'api'::text)) OR (jsonb_typeof((lic_override -> 'api'::text)) = 'boolean'::text)) AND ((NOT (lic_override ? 'bulk_export'::text)) OR (jsonb_typeof((lic_override -> 'bulk_export'::text)) = 'boolean'::text)) AND ((NOT (lic_override ? 'history_export'::text)) OR (jsonb_typeof((lic_override -> 'history_export'::text)) = 'boolean'::text))))),
    CONSTRAINT series_native_step_check CHECK ((native_step > '00:00:00'::interval)),
    CONSTRAINT series_quantity_check CHECK ((quantity = ANY (ARRAY['H'::text, 'Q'::text]))),
    CONSTRAINT series_role_check CHECK ((role = ANY (ARRAY['primary'::text, 'twin'::text, 'mirror'::text]))),
    CONSTRAINT series_staleness_limit_check CHECK ((staleness_limit > '00:00:00'::interval)),
    CONSTRAINT series_to_canonical_check CHECK ((to_canonical > (0)::double precision)),
    CONSTRAINT series_value_kind_check CHECK ((value_kind = ANY (ARRAY['stage'::text, 'level'::text])))
);


--
-- Name: source; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source (
    id text NOT NULL,
    provider_id text NOT NULL,
    name text NOT NULL,
    licence text,
    licence_kind text,
    audience public.audience NOT NULL,
    permission_ref text,
    private_basis jsonb,
    lic_display boolean NOT NULL,
    lic_api boolean NOT NULL,
    lic_bulk_export boolean NOT NULL,
    lic_history_export boolean NOT NULL,
    history_window interval DEFAULT '00:00:00'::interval NOT NULL,
    capture_enabled boolean NOT NULL,
    canary boolean DEFAULT false NOT NULL,
    notes text,
    CONSTRAINT source_history_window_check CHECK (((history_window >= '00:00:00'::interval) AND (EXTRACT(year FROM history_window) = (0)::numeric) AND (EXTRACT(month FROM history_window) = (0)::numeric) AND (EXTRACT(day FROM history_window) = (0)::numeric))),
    CONSTRAINT source_id_check CHECK ((id ~ '^((NL|DE|BE|FR|LU|CH)-[1-9][0-9]?|CANARY-[A-Z]+)$'::text)),
    CONSTRAINT source_owner_has_private_basis CHECK (((audience <> 'owner'::public.audience) OR ((private_basis IS NOT NULL) AND (jsonb_typeof(private_basis) = 'object'::text) AND (private_basis ?& ARRAY['clause'::text, 'url'::text, 'retrieved'::text])))),
    CONSTRAINT source_owner_no_bulk_export CHECK (((audience <> 'owner'::public.audience) OR (NOT lic_bulk_export))),
    CONSTRAINT source_private_basis_only_for_owner CHECK (((private_basis IS NULL) OR (audience = 'owner'::public.audience)))
);


--
-- Name: series_eff; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.series_eff AS
 SELECT s.id AS series_id,
    s.station_id,
    s.source_id,
    s.role,
    LEAST(src.audience, COALESCE(s.audience, src.audience)) AS audience,
    (src.lic_display AND COALESCE(((s.lic_override ->> 'display'::text))::boolean, true)) AS lic_display,
    (src.lic_api AND COALESCE(((s.lic_override ->> 'api'::text))::boolean, true)) AS lic_api,
    (src.lic_bulk_export AND COALESCE(((s.lic_override ->> 'bulk_export'::text))::boolean, true)) AS lic_bulk_export,
    (src.lic_history_export AND COALESCE(((s.lic_override ->> 'history_export'::text))::boolean, true)) AS lic_history_export,
    src.history_window
   FROM (public.series s
     JOIN public.source src ON ((src.id = s.source_id)));


--
-- Name: own_api_forecast_run; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_api_forecast_run WITH (security_barrier='true') AS
 SELECT r.id,
    r.series_id,
    r.source_id,
    r.issued_at,
    r.issued_inferred,
    r.first_valid,
    r.last_valid,
    r.fetched_at,
    r.kind,
    r.step,
    r.provider_segment_end
   FROM ((public.forecast_run r
     JOIN public.series_eff e ON ((e.series_id = r.series_id)))
     JOIN public.source fs ON ((fs.id = r.source_id)))
  WHERE ((e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display AND e.lic_api AND (fs.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND fs.lic_display AND fs.lic_api);


--
-- Name: own_api_forecast_value; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_api_forecast_value WITH (security_barrier='true') AS
 SELECT run_id,
    valid_ts,
    value,
    p05,
    p10,
    p25,
    p50,
    p75,
    p90,
    p95,
    vmin,
    vmax,
    flags
   FROM public.forecast_value v
  WHERE (EXISTS ( SELECT 1
           FROM ((public.forecast_run r
             JOIN public.series_eff e ON ((e.series_id = r.series_id)))
             JOIN public.source fs ON ((fs.id = r.source_id)))
          WHERE ((e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display AND e.lic_api AND (fs.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND fs.lic_display AND fs.lic_api AND (r.id = v.run_id))));


--
-- Name: own_api_obs; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_api_obs WITH (security_barrier='true') AS
 SELECT o.series_id,
    o.ts,
    o.value,
    o.qc
   FROM (public.obs o
     JOIN public.series_eff e ON ((e.series_id = o.series_id)))
  WHERE ((e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display AND e.lic_api AND (e.lic_history_export OR (o.ts >= (now() - e.history_window))));


--
-- Name: own_api_obs_1d; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_api_obs_1d WITH (security_barrier='true') AS
 SELECT o.series_id,
    o.bucket,
    o.vmin,
    o.vmax,
    o.vavg,
    o.vlast,
    o.n,
    o.qc_or
   FROM (public.obs_1d o
     JOIN public.series_eff e ON ((e.series_id = o.series_id)))
  WHERE ((e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display AND e.lic_api AND (e.lic_history_export OR (o.bucket >= (now() - e.history_window))));


--
-- Name: own_api_obs_1h; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_api_obs_1h WITH (security_barrier='true') AS
 SELECT o.series_id,
    o.bucket,
    o.vmin,
    o.vmax,
    o.vavg,
    o.vlast,
    o.n,
    o.qc_or
   FROM (public.obs_1h o
     JOIN public.series_eff e ON ((e.series_id = o.series_id)))
  WHERE ((e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display AND e.lic_api AND (e.lic_history_export OR (o.bucket >= (now() - e.history_window))));


--
-- Name: own_api_series; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_api_series WITH (security_barrier='true') AS
 SELECT s.id,
    s.station_id,
    s.source_id,
    s.quantity,
    s.value_kind,
    s.native_unit,
    s.to_canonical,
    s.datum,
    s.expected_step,
    s.staleness_limit,
    s.active,
    e.audience
   FROM (public.series s
     JOIN public.series_eff e ON ((e.series_id = s.id)))
  WHERE ((e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display AND e.lic_api);


--
-- Name: own_attribution; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_attribution WITH (security_barrier='true') AS
 SELECT a.source_id,
    a.ord,
    a.lang,
    a.text,
    a.url,
    a.needs_date,
    a.date_kind,
    a.logo_allowed,
    a.required
   FROM (public.attribution a
     JOIN public.source s ON ((s.id = a.source_id)))
  WHERE ((s.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND s.lic_display);


--
-- Name: own_class; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_class WITH (security_barrier='true') AS
 SELECT c.subject_type,
    c.subject_id,
    c.ts,
    c.source_id,
    c.provider_code,
    c.provider_label,
    c.level_norm
   FROM (public.class_obs c
     JOIN public.source cs ON ((cs.id = c.source_id)))
  WHERE ((cs.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND cs.lic_display AND ((c.subject_type = 'area'::text) OR (EXISTS ( SELECT 1
           FROM public.series_eff e
          WHERE ((e.station_id = c.subject_id) AND (e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display)))));


--
-- Name: own_forecast_run; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_forecast_run WITH (security_barrier='true') AS
 SELECT r.id,
    r.series_id,
    r.source_id,
    r.issued_at,
    r.issued_inferred,
    r.first_valid,
    r.last_valid,
    r.fetched_at,
    r.kind,
    r.step,
    r.provider_segment_end
   FROM ((public.forecast_run r
     JOIN public.series_eff e ON ((e.series_id = r.series_id)))
     JOIN public.source fs ON ((fs.id = r.source_id)))
  WHERE ((e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display AND (fs.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND fs.lic_display);


--
-- Name: own_forecast_value; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_forecast_value WITH (security_barrier='true') AS
 SELECT run_id,
    valid_ts,
    value,
    p05,
    p10,
    p25,
    p50,
    p75,
    p90,
    p95,
    vmin,
    vmax,
    flags
   FROM public.forecast_value v
  WHERE (EXISTS ( SELECT 1
           FROM ((public.forecast_run r
             JOIN public.series_eff e ON ((e.series_id = r.series_id)))
             JOIN public.source fs ON ((fs.id = r.source_id)))
          WHERE ((e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display AND (fs.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND fs.lic_display AND (r.id = v.run_id))));


--
-- Name: own_ingest_batch; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_ingest_batch WITH (security_barrier='true') AS
 SELECT b.id,
    b.source_id,
    b.spec_id,
    b.fetched_at,
    b.parse_status,
    b.n_rows,
    b.n_new,
    b.n_changed,
    b.error,
    b.loaded_at
   FROM (public.ingest_batch b
     JOIN public.source s ON ((s.id = b.source_id)))
  WHERE (s.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience]));


--
-- Name: own_obs; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_obs WITH (security_barrier='true') AS
 SELECT o.series_id,
    o.ts,
    o.value,
    o.qc
   FROM (public.obs o
     JOIN public.series_eff e ON ((e.series_id = o.series_id)))
  WHERE ((e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display AND (e.lic_history_export OR (o.ts >= (now() - e.history_window))));


--
-- Name: own_obs_1d; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_obs_1d WITH (security_barrier='true') AS
 SELECT o.series_id,
    o.bucket,
    o.vmin,
    o.vmax,
    o.vavg,
    o.vlast,
    o.n,
    o.qc_or
   FROM (public.obs_1d o
     JOIN public.series_eff e ON ((e.series_id = o.series_id)))
  WHERE ((e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display AND (e.lic_history_export OR (o.bucket >= (now() - e.history_window))));


--
-- Name: own_obs_1h; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_obs_1h WITH (security_barrier='true') AS
 SELECT o.series_id,
    o.bucket,
    o.vmin,
    o.vmax,
    o.vavg,
    o.vlast,
    o.n,
    o.qc_or
   FROM (public.obs_1h o
     JOIN public.series_eff e ON ((e.series_id = o.series_id)))
  WHERE ((e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display AND (e.lic_history_export OR (o.bucket >= (now() - e.history_window))));


--
-- Name: own_obs_latest; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_obs_latest WITH (security_barrier='true') AS
 SELECT o.series_id,
    o.ts,
    o.value,
    o.qc
   FROM (public.obs_latest o
     JOIN public.series_eff e ON ((e.series_id = o.series_id)))
  WHERE ((e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display AND (e.lic_history_export OR (o.ts >= (now() - e.history_window))));


--
-- Name: own_private_basis; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_private_basis WITH (security_barrier='true') AS
 SELECT id AS source_id,
    private_basis
   FROM public.source s
  WHERE (audience = 'owner'::public.audience);


--
-- Name: reference_value; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reference_value (
    series_id integer NOT NULL,
    source_id text NOT NULL,
    kind text NOT NULL,
    value real NOT NULL,
    unit text NOT NULL,
    semantics text NOT NULL,
    percentile_convention text,
    period daterange,
    season_from_md smallint DEFAULT 101 NOT NULL,
    season_to_md smallint DEFAULT 1231 NOT NULL,
    priority smallint DEFAULT 0 NOT NULL,
    basis_label text,
    valid tstzrange NOT NULL,
    batch_id bigint,
    CONSTRAINT reference_value_kind_check CHECK ((kind ~ '^[A-Z0-9_]{1,40}$'::text)),
    CONSTRAINT reference_value_percentile_convention_check CHECK ((percentile_convention = ANY (ARRAY['exceedance'::text, 'non_exceedance'::text]))),
    CONSTRAINT reference_value_season_from CHECK (((((season_from_md / 100) >= 1) AND ((season_from_md / 100) <= 12)) AND ((((season_from_md)::integer % 100) >= 1) AND (((season_from_md)::integer % 100) <=
CASE
    WHEN ((season_from_md / 100) = 2) THEN 29
    WHEN ((season_from_md / 100) = ANY (ARRAY[4, 6, 9, 11])) THEN 30
    ELSE 31
END)))),
    CONSTRAINT reference_value_season_to CHECK (((((season_to_md / 100) >= 1) AND ((season_to_md / 100) <= 12)) AND ((((season_to_md)::integer % 100) >= 1) AND (((season_to_md)::integer % 100) <=
CASE
    WHEN ((season_to_md / 100) = 2) THEN 29
    WHEN ((season_to_md / 100) = ANY (ARRAY[4, 6, 9, 11])) THEN 30
    ELSE 31
END)))),
    CONSTRAINT reference_value_semantics_check CHECK ((semantics = ANY (ARRAY['operational'::text, 'statistical'::text, 'historical'::text, 'provider_class'::text]))),
    CONSTRAINT reference_value_valid_check CHECK ((NOT isempty(valid)))
);


--
-- Name: own_reference; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_reference WITH (security_barrier='true') AS
 SELECT r.series_id,
    r.source_id,
    r.kind,
    r.value,
    r.unit,
    r.semantics,
    r.percentile_convention,
    r.period,
    r.season_from_md,
    r.season_to_md,
    r.priority,
    r.basis_label,
    r.valid
   FROM ((public.reference_value r
     JOIN public.series_eff e ON ((e.series_id = r.series_id)))
     JOIN public.source rs ON ((rs.id = r.source_id)))
  WHERE ((e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display AND (rs.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND rs.lic_display);


--
-- Name: own_series; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_series WITH (security_barrier='true') AS
 SELECT s.id,
    s.station_id,
    s.source_id,
    s.quantity,
    s.value_kind,
    s.native_unit,
    s.to_canonical,
    s.datum,
    s.expected_step,
    s.staleness_limit,
    s.active,
    e.audience
   FROM (public.series s
     JOIN public.series_eff e ON ((e.series_id = s.id)))
  WHERE ((e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display);


--
-- Name: source_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_health (
    source_id text NOT NULL,
    last_fetch_ok timestamp with time zone,
    last_new_data timestamp with time zone,
    newest_ts timestamp with time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    circuit_state text,
    quarantine_count integer DEFAULT 0 NOT NULL,
    lag_p95 interval,
    status text DEFAULT 'unknown'::text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_health_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'degraded'::text, 'down'::text, 'unknown'::text])))
);


--
-- Name: own_source_health; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_source_health WITH (security_barrier='true') AS
 SELECT h.source_id,
    h.last_fetch_ok,
    h.last_new_data,
    h.newest_ts,
    h.consecutive_failures,
    h.quarantine_count,
    (EXTRACT(epoch FROM h.lag_p95))::double precision AS lag_p95_s,
    h.status,
    h.detail,
    h.updated_at
   FROM (public.source_health h
     JOIN public.source s ON ((s.id = h.source_id)))
  WHERE (s.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience]));


--
-- Name: station; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.station (
    id text NOT NULL,
    name text NOT NULL,
    water_name text,
    country text NOT NULL,
    lon double precision,
    lat double precision,
    operator_provider_id text,
    river_id text,
    reach_id integer,
    km_official real,
    km_system text,
    km_to_nl_entry real,
    nl_entry_node text,
    flags jsonb DEFAULT '{}'::jsonb NOT NULL,
    tier smallint NOT NULL,
    CONSTRAINT station_check CHECK (((lon IS NULL) = (lat IS NULL))),
    CONSTRAINT station_country_check CHECK ((country = ANY (ARRAY['NL'::text, 'DE'::text, 'BE'::text, 'FR'::text, 'LU'::text, 'CH'::text]))),
    CONSTRAINT station_id_check CHECK (((id ~ '^[a-z]{2}\.[a-z0-9-]+\.[A-Za-z0-9._-]+$'::text) AND (length(id) <= 80))),
    CONSTRAINT station_lat_check CHECK (((lat >= ('-90'::integer)::double precision) AND (lat <= (90)::double precision))),
    CONSTRAINT station_lon_check CHECK (((lon >= ('-180'::integer)::double precision) AND (lon <= (180)::double precision))),
    CONSTRAINT station_tier_check CHECK ((tier = ANY (ARRAY[1, 2])))
);


--
-- Name: own_station; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_station WITH (security_barrier='true') AS
 SELECT id,
    name,
    water_name,
    country,
    lon,
    lat,
    river_id,
    reach_id,
    km_official,
    km_system,
    km_to_nl_entry,
    nl_entry_node,
    flags,
    tier
   FROM public.station st
  WHERE (EXISTS ( SELECT 1
           FROM public.series_eff e
          WHERE ((e.station_id = st.id) AND (e.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND (e.role = 'primary'::text) AND e.lic_display)));


--
-- Name: twin; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.twin (
    id text NOT NULL,
    series_a integer NOT NULL,
    series_b integer NOT NULL,
    relation jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT twin_check CHECK ((series_a <> series_b)),
    CONSTRAINT twin_id_check CHECK ((id ~ '^[a-z0-9][a-z0-9-]*$'::text))
);


--
-- Name: twin_check; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.twin_check (
    twin_id text NOT NULL,
    window_end timestamp with time zone NOT NULL,
    n_aligned integer NOT NULL,
    median_delta real,
    max_delta real,
    lag_min real,
    ok boolean NOT NULL
);


--
-- Name: own_twin_check; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_twin_check WITH (security_barrier='true') AS
 SELECT t.twin_id,
    t.window_end,
    t.n_aligned,
    t.median_delta,
    t.max_delta,
    t.lag_min,
    t.ok
   FROM (((public.twin_check t
     JOIN public.twin w ON ((w.id = t.twin_id)))
     JOIN public.series_eff a ON ((a.series_id = w.series_a)))
     JOIN public.series_eff b ON ((b.series_id = w.series_b)))
  WHERE ((a.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND a.lic_display AND (b.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND b.lic_display);


--
-- Name: warning_area; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warning_area (
    id bigint NOT NULL,
    source_id text NOT NULL,
    area_key text NOT NULL,
    name text,
    geometry_geojson text,
    level_norm smallint,
    level_raw text,
    label_raw text,
    valid tstzrange NOT NULL,
    issued_at timestamp with time zone,
    batch_id bigint,
    CONSTRAINT warning_area_level_norm_check CHECK (((level_norm >= 1) AND (level_norm <= 5))),
    CONSTRAINT warning_area_valid_check CHECK ((NOT isempty(valid)))
);


--
-- Name: own_warning; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.own_warning WITH (security_barrier='true') AS
 SELECT w.id,
    w.source_id,
    w.area_key,
    w.name,
    w.geometry_geojson,
    w.level_norm,
    w.level_raw,
    w.label_raw,
    w.valid,
    w.issued_at
   FROM (public.warning_area w
     JOIN public.source ws ON ((ws.id = w.source_id)))
  WHERE ((ws.audience = ANY (ARRAY['public'::public.audience, 'owner'::public.audience])) AND ws.lic_display);


--
-- Name: provider; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider (
    id text NOT NULL,
    name text NOT NULL,
    country text NOT NULL,
    contact text,
    terms_url text,
    CONSTRAINT provider_id_check CHECK ((id ~ '^[a-z][a-z0-9-]*$'::text))
);


--
-- Name: pub_api_forecast_run; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_api_forecast_run WITH (security_barrier='true') AS
 SELECT r.id,
    r.series_id,
    r.source_id,
    r.issued_at,
    r.issued_inferred,
    r.first_valid,
    r.last_valid,
    r.fetched_at,
    r.kind,
    r.step,
    r.provider_segment_end
   FROM ((public.forecast_run r
     JOIN public.series_eff e ON ((e.series_id = r.series_id)))
     JOIN public.source fs ON ((fs.id = r.source_id)))
  WHERE ((e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display AND e.lic_api AND (fs.audience = 'public'::public.audience) AND fs.lic_display AND fs.lic_api);


--
-- Name: pub_api_forecast_value; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_api_forecast_value WITH (security_barrier='true') AS
 SELECT run_id,
    valid_ts,
    value,
    p05,
    p10,
    p25,
    p50,
    p75,
    p90,
    p95,
    vmin,
    vmax,
    flags
   FROM public.forecast_value v
  WHERE (EXISTS ( SELECT 1
           FROM ((public.forecast_run r
             JOIN public.series_eff e ON ((e.series_id = r.series_id)))
             JOIN public.source fs ON ((fs.id = r.source_id)))
          WHERE ((e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display AND e.lic_api AND (fs.audience = 'public'::public.audience) AND fs.lic_display AND fs.lic_api AND (r.id = v.run_id))));


--
-- Name: pub_api_obs; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_api_obs WITH (security_barrier='true') AS
 SELECT o.series_id,
    o.ts,
    o.value,
    o.qc
   FROM (public.obs o
     JOIN public.series_eff e ON ((e.series_id = o.series_id)))
  WHERE ((e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display AND e.lic_api AND (e.lic_history_export OR (o.ts >= (now() - e.history_window))));


--
-- Name: pub_api_obs_1d; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_api_obs_1d WITH (security_barrier='true') AS
 SELECT o.series_id,
    o.bucket,
    o.vmin,
    o.vmax,
    o.vavg,
    o.vlast,
    o.n,
    o.qc_or
   FROM (public.obs_1d o
     JOIN public.series_eff e ON ((e.series_id = o.series_id)))
  WHERE ((e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display AND e.lic_api AND (e.lic_history_export OR (o.bucket >= (now() - e.history_window))));


--
-- Name: pub_api_obs_1h; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_api_obs_1h WITH (security_barrier='true') AS
 SELECT o.series_id,
    o.bucket,
    o.vmin,
    o.vmax,
    o.vavg,
    o.vlast,
    o.n,
    o.qc_or
   FROM (public.obs_1h o
     JOIN public.series_eff e ON ((e.series_id = o.series_id)))
  WHERE ((e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display AND e.lic_api AND (e.lic_history_export OR (o.bucket >= (now() - e.history_window))));


--
-- Name: pub_api_series; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_api_series WITH (security_barrier='true') AS
 SELECT s.id,
    s.station_id,
    s.source_id,
    s.quantity,
    s.value_kind,
    s.native_unit,
    s.to_canonical,
    s.datum,
    s.expected_step,
    s.staleness_limit,
    s.active,
    e.audience
   FROM (public.series s
     JOIN public.series_eff e ON ((e.series_id = s.id)))
  WHERE ((e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display AND e.lic_api);


--
-- Name: pub_attribution; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_attribution WITH (security_barrier='true') AS
 SELECT a.source_id,
    a.ord,
    a.lang,
    a.text,
    a.url,
    a.needs_date,
    a.date_kind,
    a.logo_allowed,
    a.required
   FROM (public.attribution a
     JOIN public.source s ON ((s.id = a.source_id)))
  WHERE ((s.audience = 'public'::public.audience) AND s.lic_display);


--
-- Name: pub_class; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_class WITH (security_barrier='true') AS
 SELECT c.subject_type,
    c.subject_id,
    c.ts,
    c.source_id,
    c.provider_code,
    c.provider_label,
    c.level_norm
   FROM (public.class_obs c
     JOIN public.source cs ON ((cs.id = c.source_id)))
  WHERE ((cs.audience = 'public'::public.audience) AND cs.lic_display AND ((c.subject_type = 'area'::text) OR (EXISTS ( SELECT 1
           FROM public.series_eff e
          WHERE ((e.station_id = c.subject_id) AND (e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display)))));


--
-- Name: pub_forecast_run; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_forecast_run WITH (security_barrier='true') AS
 SELECT r.id,
    r.series_id,
    r.source_id,
    r.issued_at,
    r.issued_inferred,
    r.first_valid,
    r.last_valid,
    r.fetched_at,
    r.kind,
    r.step,
    r.provider_segment_end
   FROM ((public.forecast_run r
     JOIN public.series_eff e ON ((e.series_id = r.series_id)))
     JOIN public.source fs ON ((fs.id = r.source_id)))
  WHERE ((e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display AND (fs.audience = 'public'::public.audience) AND fs.lic_display);


--
-- Name: pub_forecast_value; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_forecast_value WITH (security_barrier='true') AS
 SELECT run_id,
    valid_ts,
    value,
    p05,
    p10,
    p25,
    p50,
    p75,
    p90,
    p95,
    vmin,
    vmax,
    flags
   FROM public.forecast_value v
  WHERE (EXISTS ( SELECT 1
           FROM ((public.forecast_run r
             JOIN public.series_eff e ON ((e.series_id = r.series_id)))
             JOIN public.source fs ON ((fs.id = r.source_id)))
          WHERE ((e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display AND (fs.audience = 'public'::public.audience) AND fs.lic_display AND (r.id = v.run_id))));


--
-- Name: pub_ingest_batch; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_ingest_batch WITH (security_barrier='true') AS
 SELECT b.id,
    b.source_id,
    b.spec_id,
    b.fetched_at,
    b.parse_status,
    b.n_rows,
    b.n_new,
    b.n_changed,
    b.error,
    b.loaded_at
   FROM (public.ingest_batch b
     JOIN public.source s ON ((s.id = b.source_id)))
  WHERE (s.audience = 'public'::public.audience);


--
-- Name: pub_loader; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_loader WITH (security_barrier='true') AS
 SELECT ((value ->> 'computed_at'::text))::timestamp with time zone AS computed_at,
    ((value ->> 'backlog_files'::text))::integer AS backlog_files,
    ((value ->> 'backlog_bytes'::text))::bigint AS backlog_bytes,
    ((value ->> 'backlog_age_s'::text))::double precision AS backlog_age_s,
    ((value ->> 'bad_manifest_lines'::text))::integer AS bad_manifest_lines
   FROM public.app_meta m
  WHERE (key = 'loader'::text);


--
-- Name: pub_obs; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_obs WITH (security_barrier='true') AS
 SELECT o.series_id,
    o.ts,
    o.value,
    o.qc
   FROM (public.obs o
     JOIN public.series_eff e ON ((e.series_id = o.series_id)))
  WHERE ((e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display AND (e.lic_history_export OR (o.ts >= (now() - e.history_window))));


--
-- Name: pub_obs_1d; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_obs_1d WITH (security_barrier='true') AS
 SELECT o.series_id,
    o.bucket,
    o.vmin,
    o.vmax,
    o.vavg,
    o.vlast,
    o.n,
    o.qc_or
   FROM (public.obs_1d o
     JOIN public.series_eff e ON ((e.series_id = o.series_id)))
  WHERE ((e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display AND (e.lic_history_export OR (o.bucket >= (now() - e.history_window))));


--
-- Name: pub_obs_1h; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_obs_1h WITH (security_barrier='true') AS
 SELECT o.series_id,
    o.bucket,
    o.vmin,
    o.vmax,
    o.vavg,
    o.vlast,
    o.n,
    o.qc_or
   FROM (public.obs_1h o
     JOIN public.series_eff e ON ((e.series_id = o.series_id)))
  WHERE ((e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display AND (e.lic_history_export OR (o.bucket >= (now() - e.history_window))));


--
-- Name: pub_obs_latest; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_obs_latest WITH (security_barrier='true') AS
 SELECT o.series_id,
    o.ts,
    o.value,
    o.qc
   FROM (public.obs_latest o
     JOIN public.series_eff e ON ((e.series_id = o.series_id)))
  WHERE ((e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display AND (e.lic_history_export OR (o.ts >= (now() - e.history_window))));


--
-- Name: pub_owner_health; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_owner_health WITH (security_barrier='true') AS
 SELECT (count(*) FILTER (WHERE (h.status = 'ok'::text)))::integer AS healthy,
    (count(*))::integer AS total
   FROM (public.source s
     LEFT JOIN public.source_health h ON ((h.source_id = s.id)))
  WHERE ((s.audience = 'owner'::public.audience) AND s.capture_enabled AND (NOT s.canary));


--
-- Name: pub_reference; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_reference WITH (security_barrier='true') AS
 SELECT r.series_id,
    r.source_id,
    r.kind,
    r.value,
    r.unit,
    r.semantics,
    r.percentile_convention,
    r.period,
    r.season_from_md,
    r.season_to_md,
    r.priority,
    r.basis_label,
    r.valid
   FROM ((public.reference_value r
     JOIN public.series_eff e ON ((e.series_id = r.series_id)))
     JOIN public.source rs ON ((rs.id = r.source_id)))
  WHERE ((e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display AND (rs.audience = 'public'::public.audience) AND rs.lic_display);


--
-- Name: pub_series; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_series WITH (security_barrier='true') AS
 SELECT s.id,
    s.station_id,
    s.source_id,
    s.quantity,
    s.value_kind,
    s.native_unit,
    s.to_canonical,
    s.datum,
    s.expected_step,
    s.staleness_limit,
    s.active,
    e.audience
   FROM (public.series s
     JOIN public.series_eff e ON ((e.series_id = s.id)))
  WHERE ((e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display);


--
-- Name: pub_source_health; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_source_health WITH (security_barrier='true') AS
 SELECT h.source_id,
    h.last_fetch_ok,
    h.last_new_data,
    h.newest_ts,
    h.consecutive_failures,
    h.quarantine_count,
    (EXTRACT(epoch FROM h.lag_p95))::double precision AS lag_p95_s,
    h.status,
    h.detail,
    h.updated_at
   FROM (public.source_health h
     JOIN public.source s ON ((s.id = h.source_id)))
  WHERE (s.audience = 'public'::public.audience);


--
-- Name: pub_station; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_station WITH (security_barrier='true') AS
 SELECT id,
    name,
    water_name,
    country,
    lon,
    lat,
    river_id,
    reach_id,
    km_official,
    km_system,
    km_to_nl_entry,
    nl_entry_node,
    flags,
    tier
   FROM public.station st
  WHERE (EXISTS ( SELECT 1
           FROM public.series_eff e
          WHERE ((e.station_id = st.id) AND (e.audience = 'public'::public.audience) AND (e.role = 'primary'::text) AND e.lic_display)));


--
-- Name: pub_twin_check; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_twin_check WITH (security_barrier='true') AS
 SELECT t.twin_id,
    t.window_end,
    t.n_aligned,
    t.median_delta,
    t.max_delta,
    t.lag_min,
    t.ok
   FROM (((public.twin_check t
     JOIN public.twin w ON ((w.id = t.twin_id)))
     JOIN public.series_eff a ON ((a.series_id = w.series_a)))
     JOIN public.series_eff b ON ((b.series_id = w.series_b)))
  WHERE ((a.audience = 'public'::public.audience) AND a.lic_display AND (b.audience = 'public'::public.audience) AND b.lic_display);


--
-- Name: pub_warning; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pub_warning WITH (security_barrier='true') AS
 SELECT w.id,
    w.source_id,
    w.area_key,
    w.name,
    w.geometry_geojson,
    w.level_norm,
    w.level_raw,
    w.label_raw,
    w.valid,
    w.issued_at
   FROM (public.warning_area w
     JOIN public.source ws ON ((ws.id = w.source_id)))
  WHERE ((ws.audience = 'public'::public.audience) AND ws.lic_display);


--
-- Name: reach; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reach (
    id integer NOT NULL,
    river_id text NOT NULL,
    seq integer NOT NULL,
    up_station_id text,
    down_station_id text,
    length_km real,
    flags jsonb DEFAULT '{}'::jsonb NOT NULL,
    travel_time_h numrange,
    travel_time_source text
);


--
-- Name: reach_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.reach ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.reach_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: river; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.river (
    id text NOT NULL,
    names jsonb DEFAULT '{}'::jsonb NOT NULL,
    osm_relation_id bigint,
    wikidata text,
    parent_river_id text,
    confluence_km real,
    CONSTRAINT river_id_check CHECK ((id ~ '^[a-z][a-z0-9-]*$'::text))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: series_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.series ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.series_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: station_alias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.station_alias (
    station_id text NOT NULL,
    source_id text NOT NULL,
    provider_code text NOT NULL,
    role text NOT NULL,
    precedence smallint DEFAULT 0 NOT NULL,
    CONSTRAINT station_alias_role_check CHECK ((role = ANY (ARRAY['primary'::text, 'twin'::text, 'mirror'::text])))
);


--
-- Name: warning_area_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.warning_area ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.warning_area_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: app_meta app_meta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_meta
    ADD CONSTRAINT app_meta_pkey PRIMARY KEY (key);


--
-- Name: attribution attribution_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribution
    ADD CONSTRAINT attribution_pkey PRIMARY KEY (source_id, ord);


--
-- Name: class_obs class_obs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_obs
    ADD CONSTRAINT class_obs_pkey PRIMARY KEY (subject_type, subject_id, source_id, ts);


--
-- Name: forecast_run forecast_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forecast_run
    ADD CONSTRAINT forecast_run_pkey PRIMARY KEY (id);


--
-- Name: forecast_run forecast_run_series_id_first_valid_content_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forecast_run
    ADD CONSTRAINT forecast_run_series_id_first_valid_content_hash_key UNIQUE (series_id, first_valid, content_hash);


--
-- Name: forecast_value forecast_value_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forecast_value
    ADD CONSTRAINT forecast_value_pkey PRIMARY KEY (run_id, valid_ts);


--
-- Name: gauge_zero gauge_zero_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gauge_zero
    ADD CONSTRAINT gauge_zero_pkey PRIMARY KEY (series_id, valid WITHOUT OVERLAPS);


--
-- Name: ingest_batch ingest_batch_archive_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_batch
    ADD CONSTRAINT ingest_batch_archive_key_key UNIQUE (archive_key);


--
-- Name: ingest_batch ingest_batch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_batch
    ADD CONSTRAINT ingest_batch_pkey PRIMARY KEY (id);


--
-- Name: load_cursor load_cursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.load_cursor
    ADD CONSTRAINT load_cursor_pkey PRIMARY KEY (manifest_file);


--
-- Name: obs_1d obs_1d_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obs_1d
    ADD CONSTRAINT obs_1d_pkey PRIMARY KEY (series_id, bucket);


--
-- Name: obs_1h obs_1h_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obs_1h
    ADD CONSTRAINT obs_1h_pkey PRIMARY KEY (series_id, bucket);


--
-- Name: obs_latest obs_latest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obs_latest
    ADD CONSTRAINT obs_latest_pkey PRIMARY KEY (series_id);


--
-- Name: obs obs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obs
    ADD CONSTRAINT obs_pkey PRIMARY KEY (series_id, ts);


--
-- Name: provider provider_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider
    ADD CONSTRAINT provider_pkey PRIMARY KEY (id);


--
-- Name: reach reach_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reach
    ADD CONSTRAINT reach_pkey PRIMARY KEY (id);


--
-- Name: reach reach_river_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reach
    ADD CONSTRAINT reach_river_id_seq_key UNIQUE (river_id, seq);


--
-- Name: reference_value reference_value_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reference_value
    ADD CONSTRAINT reference_value_pkey PRIMARY KEY (series_id, source_id, kind, season_from_md, season_to_md, priority, valid WITHOUT OVERLAPS);


--
-- Name: river river_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.river
    ADD CONSTRAINT river_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: series series_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.series
    ADD CONSTRAINT series_pkey PRIMARY KEY (id);


--
-- Name: series series_source_id_provider_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.series
    ADD CONSTRAINT series_source_id_provider_key_key UNIQUE (source_id, provider_key);


--
-- Name: source_health source_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_health
    ADD CONSTRAINT source_health_pkey PRIMARY KEY (source_id);


--
-- Name: source source_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source
    ADD CONSTRAINT source_pkey PRIMARY KEY (id);


--
-- Name: station_alias station_alias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.station_alias
    ADD CONSTRAINT station_alias_pkey PRIMARY KEY (source_id, provider_code);


--
-- Name: station station_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.station
    ADD CONSTRAINT station_pkey PRIMARY KEY (id);


--
-- Name: twin_check twin_check_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.twin_check
    ADD CONSTRAINT twin_check_pkey PRIMARY KEY (twin_id, window_end);


--
-- Name: twin twin_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.twin
    ADD CONSTRAINT twin_pkey PRIMARY KEY (id);


--
-- Name: warning_area warning_area_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warning_area
    ADD CONSTRAINT warning_area_pkey PRIMARY KEY (id);


--
-- Name: forecast_run_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forecast_run_source ON public.forecast_run USING btree (source_id);


--
-- Name: ingest_batch_fetched; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ingest_batch_fetched ON public.ingest_batch USING btree (fetched_at);


--
-- Name: ingest_batch_source_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ingest_batch_source_status ON public.ingest_batch USING btree (source_id, parse_status);


--
-- Name: obs_1d_bucket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX obs_1d_bucket_idx ON public.obs_1d USING btree (bucket);


--
-- Name: obs_1h_bucket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX obs_1h_bucket ON public.obs_1h USING btree (bucket);


--
-- Name: obs_revision_series_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX obs_revision_series_ts ON public.obs_revision USING btree (series_id, ts);


--
-- Name: obs_ts_brin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX obs_ts_brin ON ONLY public.obs USING brin (ts);


--
-- Name: series_station; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX series_station ON public.series USING btree (station_id);


--
-- Name: station_alias_station; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX station_alias_station ON public.station_alias USING btree (station_id);


--
-- Name: warning_area_source_valid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX warning_area_source_valid ON public.warning_area USING gist (source_id, valid);


--
-- Name: attribution attribution_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribution
    ADD CONSTRAINT attribution_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.source(id) ON DELETE CASCADE;


--
-- Name: class_obs class_obs_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_obs
    ADD CONSTRAINT class_obs_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.source(id);


--
-- Name: forecast_run forecast_run_series_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forecast_run
    ADD CONSTRAINT forecast_run_series_id_fkey FOREIGN KEY (series_id) REFERENCES public.series(id);


--
-- Name: forecast_run forecast_run_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forecast_run
    ADD CONSTRAINT forecast_run_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.source(id);


--
-- Name: forecast_value forecast_value_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.forecast_value
    ADD CONSTRAINT forecast_value_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.forecast_run(id) ON DELETE CASCADE;


--
-- Name: gauge_zero gauge_zero_series_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gauge_zero
    ADD CONSTRAINT gauge_zero_series_id_fkey FOREIGN KEY (series_id) REFERENCES public.series(id);


--
-- Name: ingest_batch ingest_batch_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_batch
    ADD CONSTRAINT ingest_batch_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.source(id);


--
-- Name: obs_1d obs_1d_series_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obs_1d
    ADD CONSTRAINT obs_1d_series_id_fkey FOREIGN KEY (series_id) REFERENCES public.series(id);


--
-- Name: obs_1h obs_1h_series_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obs_1h
    ADD CONSTRAINT obs_1h_series_id_fkey FOREIGN KEY (series_id) REFERENCES public.series(id);


--
-- Name: obs_latest obs_latest_series_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obs_latest
    ADD CONSTRAINT obs_latest_series_id_fkey FOREIGN KEY (series_id) REFERENCES public.series(id);


--
-- Name: obs_revision obs_revision_series_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obs_revision
    ADD CONSTRAINT obs_revision_series_id_fkey FOREIGN KEY (series_id) REFERENCES public.series(id);


--
-- Name: obs obs_series_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.obs
    ADD CONSTRAINT obs_series_id_fkey FOREIGN KEY (series_id) REFERENCES public.series(id);


--
-- Name: reach reach_down_station_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reach
    ADD CONSTRAINT reach_down_station_id_fkey FOREIGN KEY (down_station_id) REFERENCES public.station(id);


--
-- Name: reach reach_river_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reach
    ADD CONSTRAINT reach_river_id_fkey FOREIGN KEY (river_id) REFERENCES public.river(id);


--
-- Name: reach reach_up_station_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reach
    ADD CONSTRAINT reach_up_station_id_fkey FOREIGN KEY (up_station_id) REFERENCES public.station(id);


--
-- Name: reference_value reference_value_series_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reference_value
    ADD CONSTRAINT reference_value_series_id_fkey FOREIGN KEY (series_id) REFERENCES public.series(id);


--
-- Name: reference_value reference_value_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reference_value
    ADD CONSTRAINT reference_value_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.source(id);


--
-- Name: river river_parent_river_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.river
    ADD CONSTRAINT river_parent_river_id_fkey FOREIGN KEY (parent_river_id) REFERENCES public.river(id);


--
-- Name: series series_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.series
    ADD CONSTRAINT series_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.source(id);


--
-- Name: series series_station_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.series
    ADD CONSTRAINT series_station_id_fkey FOREIGN KEY (station_id) REFERENCES public.station(id);


--
-- Name: source_health source_health_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_health
    ADD CONSTRAINT source_health_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.source(id);


--
-- Name: source source_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source
    ADD CONSTRAINT source_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.provider(id);


--
-- Name: station_alias station_alias_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.station_alias
    ADD CONSTRAINT station_alias_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.source(id);


--
-- Name: station_alias station_alias_station_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.station_alias
    ADD CONSTRAINT station_alias_station_id_fkey FOREIGN KEY (station_id) REFERENCES public.station(id);


--
-- Name: station station_operator_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.station
    ADD CONSTRAINT station_operator_provider_id_fkey FOREIGN KEY (operator_provider_id) REFERENCES public.provider(id);


--
-- Name: station station_reach_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.station
    ADD CONSTRAINT station_reach_id_fkey FOREIGN KEY (reach_id) REFERENCES public.reach(id);


--
-- Name: station station_river_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.station
    ADD CONSTRAINT station_river_id_fkey FOREIGN KEY (river_id) REFERENCES public.river(id);


--
-- Name: twin_check twin_check_twin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.twin_check
    ADD CONSTRAINT twin_check_twin_id_fkey FOREIGN KEY (twin_id) REFERENCES public.twin(id);


--
-- Name: twin twin_series_a_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.twin
    ADD CONSTRAINT twin_series_a_fkey FOREIGN KEY (series_a) REFERENCES public.series(id);


--
-- Name: twin twin_series_b_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.twin
    ADD CONSTRAINT twin_series_b_fkey FOREIGN KEY (series_b) REFERENCES public.series(id);


--
-- Name: warning_area warning_area_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warning_area
    ADD CONSTRAINT warning_area_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.source(id);


--
-- PostgreSQL database dump complete
--



--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20261003000001'),
    ('20261003000002'),
    ('20261003000003'),
    ('20261003000004'),
    ('20261003000005'),
    ('20261003000006'),
    ('20261003000007');
