# ADR-0005: Static-first serving

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

Flood spikes must not reach Node or PostgreSQL.

## Decision

A publisher writes compressed files per 10-minute bucket, split into recent and settled classes, with per-day versions for immutability. Caddy serves them. The API is a bounded fallback with load shedding.

## Consequences

A spike costs disk reads. A revision re-renders one day. The client needs version-aware URLs.
