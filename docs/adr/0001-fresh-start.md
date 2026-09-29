# ADR-0001: Fresh start

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

The legacy code encodes assumptions we no longer hold.

## Decision

Tag `a4106b8` as `legacy-v0`, remove everything from `main`, and add a CI blob check against `legacy-v0`. `CLAUDE.md` forbids reading or restoring legacy code.

## Consequences

Nothing is reused. History stays available through the tag.
