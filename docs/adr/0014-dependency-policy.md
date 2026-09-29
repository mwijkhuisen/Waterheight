# ADR-0014: Dependency policy

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

The 2026 npm worm and the action-tag hijack.

## Decision

Pnpm `minimumReleaseAge` of 7 days, `allowBuilds`, a frozen lockfile, Dependabot with a 7-day cooldown and no automerge, SHA pins, and an ADR-lite for each new dependency. The override procedure for urgent security fixes is documented in `CLAUDE.md`.

## Consequences

Updates arrive a week late, and that is deliberate.
