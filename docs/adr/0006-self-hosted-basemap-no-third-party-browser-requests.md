# ADR-0006: Self-hosted basemap; no third-party browser requests

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

Free tile services have no SLA, and visitor privacy matters.

## Decision

A Protomaps extract with go-pmtiles and self-hosted glyphs and sprites. The previous file is kept for rollback. OpenFreeMap is for development only.

## Consequences

About 9 GB on disk, a quarterly refresh job and a strict CSP.
