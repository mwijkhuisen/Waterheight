-- Cache for upstream responses that are too slow or too chatty to fetch per
-- request. Lives in Postgres rather than memory so a restart does not lose the
-- ability to serve stale data during an upstream outage, and so a stale
-- response can honestly report when it was fetched.
CREATE TABLE upstream_cache (
  key         text PRIMARY KEY,
  payload     jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX upstream_cache_expiry_idx ON upstream_cache (expires_at);
