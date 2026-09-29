# ADR-0003: Capture-first raw archive

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

Forecast runs, alert and class states (including LINDAS `dangerLevel`), threshold versions and raw-as-published values are overwritten upstream and can never be refilled; most observations can be refilled later by API or by order (§0.1 "recoverable by").

## Decision

A capture-only recorder with no DB credentials. The archive is the source of truth and the DB is a replayable projection. The §0.1a streams are enabled first, and the §0.1b day-0 harvest seeds the rolling windows. Retention: observation payloads 90 days after parse; forecast, reference, class, warning and metadata payloads forever; class and threshold changes inside mixed payloads forever (§7.2).

## Consequences

Parser bugs can be recovered. Disk use is bounded and measured. Replay needs to be fast.
