# ADR-0008: Pull-based signed deploys

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

A server credential stored in GitHub is a compromise path.

## Decision

Releases are cosign-signed and approved through the `production` environment. The VPS pulls, verifies with an identity pinned to `release.yml`, migrates, smoke-tests and rolls back automatically.

## Consequences

Up to 5 minutes of deploy latency, and no inbound deploy path.
