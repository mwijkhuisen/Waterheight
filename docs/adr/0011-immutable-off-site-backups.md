# ADR-0011: Immutable off-site backups

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

The VPS is a single failure domain.

## Decision

Restic to an EU bucket with versioning and Object Lock, hourly for the raw archive (RPO ≤ 1 h). The VPS key cannot delete versions; pruning runs from the owner's workstation. Monthly automated restore drill.

## Consequences

The owner needs a workstation key and a monthly check. Ransomware on the VPS cannot erase the history.
