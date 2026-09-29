# ADR-0015: Tests on real PostgreSQL, not testcontainers

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

Agent sandboxes usually lack Docker.

## Decision

The SessionStart hook starts a native PG 18 cluster; CI uses a digest-pinned service container. All tests are offline, with msw erroring on unhandled requests.

## Consequences

Integration tests run everywhere agents work.
