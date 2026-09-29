# ADR-0007: Licence gating in data

- **Status:** Accepted; amended 2026-09-24 (decision D22: `audience` replaces `publication`, `dark` retired)
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

HIC, VMM, SPW, NLWKN, AGE, BfG, LfU RLP and LUBW impose conditions (§0.2). Our own API and exports are redistribution, and several licences attach a duty to each response (§0.7).

## Decision

`audience: public | owner | off` per source ID (amended 2026-09-24; it replaces `publication: public | dark | off`, and `dark` is retired: DE-2 and DE-3 became `owner`, and the RLP-operated gauges inside LU-1 became withheld series, `off`), plus the channel flags `display`, `api`, `bulk_export` and `history_export` enforced in the views inside each audience (a series may narrow the audience and the flags, never widen them). Public web roles see only `pub_*` views; the owner channel only `own_*` views (ADR-0017). A withheld canary, a display-only canary and an owner canary. Every response carries the required attribution and dates. Changing a flag needs a permission record (for `owner`, a `private_basis`), and every permission request asks about API redistribution and history archives. NLWKN, LfU RLP and LUBW are **off** (no capture) until written permission; SPW and AGE LU-2/3/4 are `owner` (ADR-0017).

## Consequences

Until P13, the public site covers Belgium with the ~25 ungated points of §0.6 (RWS points on Belgian soil and Hub'Eau partner stations); there the Walloon Meuse between Chooz and Lixhe, the Scheldt between Maulde and Antwerp, the Dender and the Kempen rivers stay empty, while the owner view fills the Walloon part from SPW. A source granted "for display only" never reaches the API. Nothing is stored or served beyond what its terms allow for its audience.
