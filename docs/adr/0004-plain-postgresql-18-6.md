# ADR-0004: Plain PostgreSQL 18.6

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

Measured 16–20 ms at-T queries; at most 23 GB/yr (§6.1–6.2); TSL licence and upgrade friction.

## Decision

No TimescaleDB. Monthly partitions, BRIN, incremental rollups in the loader transaction, nightly reconciliation, builtin C.UTF-8.

## Consequences

Standard dumps and upgrades. Revisit compression or Parquet export in P14 at about 50 GB.
