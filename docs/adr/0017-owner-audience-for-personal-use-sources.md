# ADR-0017: Owner audience for personal-use sources

- **Status:** Accepted (2026-09-24; decision D22)
- **Date:** 2026-09-24
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

SPW (BE-3) and AGE (LU-2/3/4) forbid giving their data to third parties or the public without written consent, but allow reproduction or use for personal, strictly private purposes; the BfG duties (credit, Belegexemplar) attach to publications (catalogue §0.8). Without a private route, the Walloon Meuse, the Luxembourg forecasts and thresholds and the BfG 14-day forecasts stay invisible even to the owner until consent arrives, and LU-3 runs and LU-4 threshold versions are lost for good. NLWKN, LfU RLP and LUBW exclude even private storage or copying without consent. The owner accepts a view that only they can use.

## Decision

- A per-source `audience: public | owner | off` (series may only narrow it) and, for `owner`, a mandatory `private_basis` (the verbatim clause, URL and retrieval date from catalogue §0.8). Audience and the §0.7 channel flags are orthogonal: the channels apply inside each audience, and an owner-audience source defaults to `display`, `api` and `history_export` on for the owner channel and `bulk_export` off.
- Initial values: `public` for the open sources, plus CH-2/CH-4/CH-5 (owner if BAFU objects in C13); `owner` for BE-3, LU-2, LU-3, LU-4, DE-3 and DE-2 (DE-2 becomes public after the Belegexemplar, P12); `off` for DE-9, DE-10, DE-12 (and DE-13 in the backlog), and for BE-1/BE-2 until their credentials arrive, after which they are `owner` (public only if the agreement or token terms allow).
- Owner-audience sources are captured from day one (P1) with the same politeness, allowlist and attribution as public ones.
- **Isolation by construction:** separate `own_*` views and the read-only role `rws_owner_api` (the public roles have no grant on them); separate processes (`publish-owner`, `api-owner`), a separate output volume (`/srv/rws/owner`) and a separate Caddy site; derived values computed per audience; an owner canary in CI and production; synthetic fixtures for owner sources in the public repository.
- **Access:** the owner site listens only on the VPS WireGuard address, whose only peers are the owner's devices, and sits behind `basic_auth` (bcrypt, long random password) as defence in depth. It has no public DNS record, uses `tls internal`, sends `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`, and shows a persistent "Persoonlijk gebruik — niet delen / Personal use only — do not share" banner that links each `private_basis`.
- One SPA build; `/runtime-config.json` per site switches owner mode.
- HIC and VMM are asked for credentials for a personal, non-commercial, private viewer (optionally also for public display); SPW and AGE are asked only for public display, which no longer blocks anything.

## Consequences

The owner sees the Walloon Meuse, the Luxembourg forecasts and thresholds and the BfG forecasts from P5c/P7/P8; the public site is unchanged. Two more services (about 512 MB), one more DB role, one more healthchecks group, and WireGuard on the host (P12a; owner action A8). Sharing the owner view with anyone, including by screenshot, would be distribution to third parties, so access stays with the owner's devices and the banner says so. Flipping a source from `owner` to `public` needs that provider's written consent, recorded in `registry/permissions/<ID>.md` (P13). Station identification rows of owner sources (number, name, coordinates) are in the public registry; everything else stays in the owner channel, apart from the isolated sample values the catalogue and research reports quote as format evidence (invariant 11). This is not legal advice: the enforceability of rights in raw measurements was not assessed, and the plan follows the terms as written.
