# ADR-0009: Honest classification

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

Agencies' references differ, and absolute heights mostly reflect bed slope (§4.3).

## Decision

One ordinal scale `no_ref < low < normal < elevated < high < extreme`, filled in the priority operational > statistical > provider class, with a `basis` on every state. The provider-by-provider mapping is the catalogue §4.9 crosswalk, signed off by the owner (D18); gauge classes and area classes are kept apart, and a gauge class wins where both exist. NL-4 classes are Waterinfo display classes and are never presented as warnings. Δh and Q are datum-free modes. No cross-border absolute comparison, and no converted absolute heights in the first release for French stations or any gauge zero taken only from Hub'Eau metadata (C40). `docs/classification.md` is generated from the code's mapping table.

## Consequences

Some markers are grey (`no_ref`). A coverage report makes that honesty visible.
