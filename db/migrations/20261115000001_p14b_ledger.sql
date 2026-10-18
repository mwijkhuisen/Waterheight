-- migrate:up

-- P14b: one archive object can be loaded as several ledger chunks. A DE-8 decade file is fetched once per job and
-- its manifest lines are slices of it (one per chunk, same archive key, different `backfill.from`), so the ledger
-- row is per (job, archive key, chunk start). A re-fetched or replayed line of the same slice still counts once.
ALTER TABLE backfill_chunk DROP CONSTRAINT backfill_chunk_pkey;
ALTER TABLE backfill_chunk ADD CONSTRAINT backfill_chunk_pkey PRIMARY KEY (job_id, archive_key, chunk_from);

-- migrate:down

-- Forward-only in effect: the old key cannot hold two slices of one object, so the down deletes every row that shares
-- (job_id, archive_key) with a row of an earlier chunk_from (the first slice is kept). The jobs' summed counts are not
-- reduced, so a job with such slices no longer reconciles against its ledger after a roll back.
DELETE FROM backfill_chunk c
USING backfill_chunk k
WHERE k.job_id = c.job_id AND k.archive_key = c.archive_key AND k.chunk_from < c.chunk_from;
ALTER TABLE backfill_chunk DROP CONSTRAINT backfill_chunk_pkey;
ALTER TABLE backfill_chunk ADD CONSTRAINT backfill_chunk_pkey PRIMARY KEY (job_id, archive_key);
