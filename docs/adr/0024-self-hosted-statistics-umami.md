# ADR-0024: Self-hosted statistics (Umami) at stats.waterradar.io

- **Status:** Accepted (owner, 2026-11-12 and 2026-11-14; issue #270, `docs/plan/PHASES.md` §65). Part A (the stack) is this change; part B (the tracker, the CSP and the privacy text) follows in its own PR.
- **Date:** 2026-11-14
- **Revisit:** when part B ships, when the owner wants history kept or backed up (D2, D3), or when Umami changes its licence or stops publishing releases.

## Context

- **The owner wants visit counts.** Page views per page and per country, without cookies and without storing visitor addresses (`docs/plan/ARCHITECTURE.md` §12, "Privacy").
- **Nothing counts visits today.** A§9 and the privacy page say "no cookies, no analytics". A third-party analytics service would also break security invariant 7 (the browser makes no third-party requests) and ADR-0006.
- **The VM already hosts two compose projects** (`rws`, and F1 Timings' `f1`). A third one can follow the F1 pattern: its own networks, secrets, GIDs and nftables table.

## Decision

1. **Umami 3.4.1** (`ghcr.io/umami-software/umami:3.4.1@sha256:e69d1a79…`, pinned by index digest) with **its own PostgreSQL 18** (`postgres:18.6-trixie`, digest-pinned) and **its own cloudflared** (2026.10.6), as the compose project `stats` in `deploy/stats/` (CLAUDE.md, "Stats stack (#270, ADR-0024)"). It shares no network, volume, secret, GID (63001 to 63099), subnet (10.63.1 to 4.0/24) or nftables table with `rws` or `f1`.
2. **The tunnel routes `^/api/send$` only** to Umami (`deploy/stats/cloudflared.yml`); everything else at `stats.waterradar.io` is `http_status:404`. The dashboard and `/mcp` listen on `10.66.0.1:8444`, reachable from a WireGuard peer only.
3. **Hardening as for the other projects:** read-only root, `cap_drop: [ALL]`, `no-new-privileges`, numeric non-root users, memory, CPU and PID limits, secrets as files, no environment secret except what Umami's own entrypoint builds in its process (R-112), and its own `table inet stats` that drops all egress except cloudflared's TCP 7844 to Cloudflare and DNS to the host's resolvers (`deploy/stats/nftables-stats.conf`).

### Owner defaults (issue #270, 2026-11-12)

- **D1** The dashboard and `/mcp` are reachable over WireGuard only.
- **D2** No backup and no healthchecks.io ping for `stats`. A lost database loses the counts and nothing else.
- **D3** History is kept until the owner deletes it.
- **D4** Updates by hand, by digest, from a release at least 7 days old.
- **D5** Two PRs: A is this stack, B is the tracker, the CSP change and the privacy text.

### Alternatives (rejected in the issue)

- **Plausible CE:** needs ClickHouse (about 2 GB of RAM as a floor) on a VM shared with two sites.
- **GoatCounter:** one maintainer and a plainer UI.
- A hosted analytics service: a third-party request from the browser (invariant 7, ADR-0006).

### Relation to ADR-0006 and the invariants

- **Invariant 7 keeps its text.** `stats.waterradar.io` is the owner's own host in the same registrable domain (same site). This is an exception to ADR-0006 in spirit only: no third party sees a visitor. Part B's Playwright spec for off-origin requests names this host as the one allowed exception.
- **Invariant 10 (CSP).** Part B adds the host to `connect-src` (and `script-src` if the tracker is loaded from it). This ADR covers that change; part B still states the exact diff.
- **Never touch `table inet rws`: one named waiver (owner, 2026-11-14).** `deploy/host/nftables.conf` drops anything from `wg0` that is not forwarded to the owner bridge. A drop in any base chain is final, so no peer could reach `10.66.0.1:8444`. The line becomes `iifname "wg0" oifname != { "rws-owner-pub", "stats-publish" } drop`, and `table inet stats` does all the filtering behind it. It needs one rws bootstrap re-run (`docs/runbooks/stats.md` §4; R-117).

### Where reality differs from #270

1. **The rws line** above: #270 assumed the stack could stay out of `table inet rws`.
2. **Host files live in `deploy/stats/`**, not in `deploy/host/` and `deploy/systemd/`: rws `bootstrap.sh` installs every `deploy/systemd/*`, and `rws-lib.sh host_files()` hashes `deploy/host/*` and `deploy/systemd/*`, so `rws-update` would page `host_files_changed` after every stats edit. The runbook installs them by hand.
3. **The tunnel secret is the tunnel token**, read with `--token-file`, not the credentials JSON. The tunnel stays locally managed, with the repo file as its ingress (cloudflared parses the local `--config` ingress on every run path, token included). This keeps the tunnel UUID out of the repository, as for rws and F1.

### ADR-lite line for the Umami image (invariant 5)

- **Why:** it is the self-hosted, cookieless counter the owner chose (2026-11-12); nothing in the repository's own dependencies counts visits.
- **Licence:** MIT.
- **Maintainer health:** Umami Software, Inc.; v3.4.1 was released 2026-10-23, v3.5.0 on 2026-11-12 (the project releases about monthly). v3.4.1 is pinned because 3.5.0 was under 7 days old.
- **Transitive count:** the image's own `package.json` at v3.4.1 lists 61 direct `dependencies`; the full transitive tree is not counted. This is the image's own tree, not this repository's lockfile: `pnpm-lock.yaml` and the web bundle are unchanged.

## Consequences

- A visit count exists only after part B ships the tracker; until then the stack holds no data and the public site is unchanged.
- The VM carries a third compose project and a second cloudflared; its images are outside the rws Grype gate and updated by hand (KG-509).
- Open risks and gaps: R-111 to R-117, KG-508 to KG-512. Threats: `docs/threat-model.md` v4.91.
- Rejected variants stay rejected; a different tool is a new ADR.
