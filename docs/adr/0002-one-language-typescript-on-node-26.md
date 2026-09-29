# ADR-0002: One language: TypeScript on Node 26

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

One owner; agents are most fluent in TypeScript; the catalogue's §7.8 default.

## Decision

TS 6.0.3 strict for server, web and geo tooling. Go (secure-ops) and Python (the geo toolchain) are rejected.

## Consequences

One toolchain and shared contracts. The npm supply-chain risk is handled by pnpm policy, cooldowns and a small dependency set. Revisit TS 7 when 7.1 ships a stable API.
