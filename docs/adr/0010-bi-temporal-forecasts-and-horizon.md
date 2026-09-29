# ADR-0010: Bi-temporal forecasts and horizon

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

Horizons differ: RWS about 34 h, WV 96 h (48–96 h "estimate"), BAFU about 115 h, LU about 45 h, Vigicrues about 21 h and event-only.

## Decision

Runs keyed by (series, first valid time, content hash). The slider goes up to +48 h, but never beyond each station's provider horizon. Values past the provider's forecast segment are styled "estimate". Providers are never blended. Only official forecasts: EFAS (real-time restricted) and GloFAS (modelled) are not used in the first release (catalogue §0.5).

## Consequences

The future view is uneven across stations, and the UI says so. At first release the Meuse above Eijsden and the Moselle, Saar, Main, Neckar, Lahn and Ems have no official forecast outside French events; the LfU RLP permission (66 gauges, P13) changes that most (§0.5).
