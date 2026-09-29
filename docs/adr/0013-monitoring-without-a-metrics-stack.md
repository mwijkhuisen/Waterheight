# ADR-0013: Monitoring without a metrics stack

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

The signal that matters is freshness, and alerts must work when the VPS is down.

## Decision

`source_health` in the DB, a public status page, healthchecks.io dead-man switches and a watchdog. Prometheus and Grafana are deferred until after launch.

## Consequences

Less insight into performance, which is compensated by k6 in CI and the brownout flag.
