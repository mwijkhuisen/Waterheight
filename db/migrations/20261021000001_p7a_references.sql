-- migrate:up

-- P7a: references, classes and warnings are loaded from the raw archive with validity ranges (PHASES P7a).
--
-- reference_value: `batch_id` stays the payload that opened a range (its provenance, and the pruner's forever
-- promotion of a CH-1/CH-2 payload whose threshold changed); `seen_at`/`seen_batch` are the newest payload that
-- stated the row, which orders a late payload against it (newest fetch wins, as for observations). The NL-4 rows
-- of the registry sync have neither.
ALTER TABLE reference_value
  ADD COLUMN seen_at timestamptz,
  ADD COLUMN seen_batch bigint;

-- warning_area: the provider's message identifier (CAP `identifier`, for Update and Cancel), the message texts per
-- language (CAP headline and description of each `<info>` block), the newest payload that stated the row, and no
-- two ranges of one area of one source that overlap (the loader caps and closes before it inserts).
ALTER TABLE warning_area
  ADD COLUMN provider_ref text CHECK (length(provider_ref) <= 200),
  ADD COLUMN texts jsonb CHECK (octet_length(texts::text) <= 65536),
  ADD COLUMN seen_at timestamptz,
  ADD COLUMN seen_batch bigint,
  ADD CONSTRAINT warning_area_no_overlap EXCLUDE USING gist (source_id WITH =, area_key WITH =, valid WITH &&);

-- The pruner asks, per archived payload, whether its batch opened a class or reference row (the forever promotion).
CREATE INDEX class_obs_batch ON class_obs (batch_id);
CREATE INDEX reference_value_batch ON reference_value (batch_id);
CREATE INDEX warning_area_batch ON warning_area (batch_id);

-- migrate:down

DROP INDEX warning_area_batch;
DROP INDEX reference_value_batch;
DROP INDEX class_obs_batch;
ALTER TABLE warning_area
  DROP CONSTRAINT warning_area_no_overlap,
  DROP COLUMN seen_batch,
  DROP COLUMN seen_at,
  DROP COLUMN texts,
  DROP COLUMN provider_ref;
ALTER TABLE reference_value
  DROP COLUMN seen_batch,
  DROP COLUMN seen_at;
