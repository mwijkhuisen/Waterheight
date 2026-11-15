# ADR-0024: Self-hosted statistics (Umami) at stats.waterradar.io

- **Status:** Accepted (owner, 2026-11-12 and 2026-11-14; issue #270, `docs/plan/PHASES.md` §65). Part A (the stack) shipped in #276; part B (the tracker, the CSP and the privacy text) is its own PR, part of #270.
- **Date:** 2026-11-14
- **Revisit:** when the owner wants a second tracker attribute or a new Umami release (the tracker is vendored and refreshed with the image, runbook §9), when the owner wants history kept or backed up (D2, D3), or when Umami changes its licence or stops publishing releases.

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
- **Invariant 10 (CSP).** Part B adds the host to `connect-src` only. `script-src` stays `'self'`, because the tracker is same-origin code (section "Part B" below). This ADR covers that change and states the exact diff there.
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

## Part B: the tracker and the CSP

- **The tag.** Last in `<body>` of `apps/web/index.html` and `apps/web/en/index.html`:
  `<script type="[[`text/javascript`]]" defer src="/assets/stats-654f12c7.js" data-website-id="<id>" data-host-url="https://stats.waterradar.io" data-domains="waterradar.io" data-do-not-track="true" data-exclude-search="true"></script>`
  The website ID is the one of runbook §7; the repository holds the nil UUID until the owner pastes it.
- **The script is vendored.** `apps/web/public/assets/stats-654f12c7.js` is byte for byte `/app/public/script.js` of the pinned image (Umami 3.4.1, sha256 `654f12c7548be726eba5b71d5ef8bffc2a41a39a0053e2a49a847869ccd7ac3f`, 4773 bytes, MIT; licence in `apps/web/vendor/umami/LICENSE` and `/third-party-notices.txt`). `scripts/umami-tracker.sh` reads it from the registry for every linux platform and fails unless they agree. It is a BOM row of kind `asset` (`umami tracker`), checked by `check-bom`, and refreshed with every image bump (runbook §9).
- **The CSP diff** (`deploy/web/site.caddy`, both copies; `docs/plan/ARCHITECTURE.md:1020`; ADR-0016; `test/verify-prod.test.ts`):
  - before: `connect-src 'self'`
  - after: `connect-src 'self' https://stats.waterradar.io`
  - `script-src` stays `'self'`. `deploy/web/owner.caddy` is unchanged: `connect-src 'self'`.
- **What the tracker does** (read in the pinned source): reads only `localStorage.umami.disabled`, writes no storage and no cookie, sends `fetch` with `credentials: 'omit'` and `keepalive` to `/api/send`, matches `data-domains` by exact hostname (CI, localhost and `owner.waterradar.io` never send), and honours Do Not Track. The server stores no IP. Cloudflare and Umami still see the visitor's address and user agent while the request is handled.
- **CORS.** `/api/*` answers `Access-Control-Allow-Origin: *` with a one-day preflight cache: one preflight per browser per day.
- **Invariant 7.** The browser's one request beyond this site goes to the owner's host; the off-origin Playwright check names it as the one exception.

### Where part B differs from #270

1. **A fifth attribute, `data-exclude-search="true"`.** `apps/web/src/lib/url/useUrlState.ts:44` rewrites `?t=` and `?s=` with `history.replaceState`, which the tracker hooks. Without the attribute every timebar step or station pick would be a page view and the query would be stored. With it a page counts once, no query is stored and the referrer's query is stripped.
2. **The owner site gate.** The owner site serves the same `/srv/www`. Only `site.caddy` runs the templates module over the page shells, so only there does `type` render as `text/javascript`. On the owner site the raw `[[...]]` value is no JavaScript MIME type, so the tag is an inert data block: never fetched, never run. `owner.caddy` stays unchanged and keeps `connect-src 'self'`.
3. **`/assets/stats-<sha8>.js` instead of `/<name>.js`.** The existing immutable `@assets` route serves it, so no route is added and the page routes are untouched. A new version is a new file name.
4. **"Part of #270", not a closing change.** The [owner] and [agent-prod] boxes of A, B's [agent-prod] checks and the E5 approval stay open after the merge; the owner closes #270.

## Consequences

- A visit count exists only once part B is deployed with the real website ID; before that the stack holds no data.
- The VM carries a third compose project and a second cloudflared; its images are outside the rws Grype gate and updated by hand (KG-509).
- Open risks and gaps: R-111 to R-117, KG-508 to KG-513. Threats: `docs/threat-model.md` v4.91 (part A) and v4.92 (part B).
- Rejected variants stay rejected; a different tool is a new ADR.
