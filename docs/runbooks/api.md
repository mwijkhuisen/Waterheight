# Runbook: the API's limits, saturation and the owner API

**Trigger:**
- visitors or the watchdog report `429` or `503` answers from `/api/v1/*`, or a healthcheck of the API answers `X-Stale: 1` for long;
- the `api` log shows `api unavailable`, `limiter` with `limiter_gateway_key`, or a flood of `beacon` lines;
- `scripts/verify-prod.sh <domain>` prints `FAIL api sweep` or `FAIL settled sweep`;
- after the P9b release: the one [owner] check of §6 (which client addresses the API sees).

The API (`api`, role `rws_api`) is a bounded fallback behind the static files of `docs/runbooks/publisher.md`: the hot path is a file Caddy serves, and the API answers what no file holds. It is public, rate-limited and "unofficial, no SLA" (D6). Its design is A§9.2 ("P9b, as built"); the threats are T-API-2 to T-API-5. The API keeps no access log of its own: requests are in the Caddy access log (§3), faults in the `api` log.

## 1. What runs

| Process | Role and views | Pool | DB permits | Where |
|---|---|---|---|---|
| `api` | `node apps/server/dist/main.js api`, as `rws_api` over the public views | 10 (the role's `CONNECTION LIMIT` is 12) | 16 | `compose.yaml`, behind `caddy` |
| `api-owner` | `api --audience owner`, as `rws_owner_api` over the owner views | 2 (the role's limit is 4; `publish-owner` takes the other 2) | 2 | the overlay `deploy/compose.owner.yaml` only, on `owner_edge`: **not started in production before P12a** (KG-226) |

One process serves one family, chosen by its command line and never by a request. Each has its own cache, limiter, semaphore, day versions and display window.

## 2. The limits

| Limit | Value | Answer when exceeded |
|---|---|---|
| Per-client general bucket (every `/api/v1/*` request, health and `/openapi.json` included) | 30 requests a second, burst 120 | 429 `rate_limited`, `Retry-After` |
| Per-client heavy bucket (`/series/*`, `/frames`), taken **in addition** | 5 a second, burst 20 | 429 `rate_limited`, `Retry-After` |
| Per-client beacon bucket (`POST /api/v1/beacon`, instead of general) | 1 a second, burst 10; and 20 a second, burst 100 for all clients together | 429 `rate_limited`, `Retry-After` |
| Query string | at most 256 bytes, `?` included | 400 `bad_parameter` (before anything is parsed) |
| Beacon body | at most 8,192 bytes (Caddy: 8 KB) | 413 `too_large` |
| Computations touching the database at once | 16 permits public, 2 owner; at most 2 × permits waiters, each for at most 250 ms | 503 `busy`, `Retry-After: 2` |
| Distinct keys computed at once | 64 (`meta` and `stations` never refused) | 503 `busy`, `Retry-After: 2` |
| The cache | 2,048 entries, 64 MiB (the zstd and gzip forms count) | the least recently used goes |

- **The client** is the key `X-Rws-Client`, which Caddy sets to the TCP peer on every proxied request and which replaces any value a client sent. IPv4 is itself, an IPv4-mapped IPv6 address is its IPv4, other IPv6 addresses are their /64. A peer in 10/8, 127/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, `::1`, `fc00::/7` or `fe80::/10` is the key `unknown-gw` (a Docker bridge or the host, never a visitor), whose buckets are **100 times larger**, and a missing or invalid value is the shared key `unknown`.
- `Retry-After` is a whole number of seconds, at least 1: the time until one token is back. A refused request takes no token, so a client that waits it out is served.
- The limiter keeps at most 50,000 keys and forgets a client whose bucket is full again, so a long-quiet client is never remembered.
- **Static files are never limited.** `/data`, `/assets`, `/tiles` and the pages are served by Caddy and never reach the API, so a crowd behind one address is never locked out of the map; only a flood of API requests from one address is limited.
- Every refusal is the body `{"error": <code>, "attribution": []}` with `Cache-Control: no-store`; nothing of the request is echoed. The codes are in `API_ERROR_CODES` (`packages/contracts`).

## 3. Reading the rates

The API logs only faults, so the rate of 429 and 503 is read from Caddy's access log, which masks addresses (IPv4 to /24, IPv6 to /48) and keeps 14 days:

```bash
# status codes of the API per minute, newest day
sudo docker exec rws-caddy-1 cat /data/access/access.log \
  | jq -r 'select(.request.uri | startswith("/api/v1/")) | "\(.ts | floor | strftime("%Y-%m-%dT%H:%MZ")) \(.status)"' \
  | sort | uniq -c | tail -n 40
# who is limited: masked prefix and path of the 429s
sudo docker exec rws-caddy-1 cat /data/access/access.log \
  | jq -r 'select(.status == 429) | "\(.request.remote_ip) \(.request.uri | split("?")[0])"' | sort | uniq -c | sort -rn | head
```

| You see | Meaning | Do |
|---|---|---|
| A few 429 from one prefix | One client above 30 a second, or above 5 a second on `/series`: the limiter works | Nothing; the client's `Retry-After` tells it when to come back |
| 429 from many prefixes at once, or from the page's own paths | The limit is too low for the real traffic, or the key collapsed (see §6) | Check §6 first; a client address behind a proxy that is not ours is not our case |
| 503 `busy` with `Retry-After: 2`, no `api unavailable` lines | The semaphore or the cap of 64 keys is saturated: a flood of uncached requests. The static files and the stale health body still answer | §4; if it lasts, `docs/runbooks/disk-full.md` and the database load (`docker stats`), and watch `load_backlog` |
| 503 `unavailable` and `api unavailable` lines | A database error: see the `code` (the SQLSTATE or a fixed word) | `57014` is the 2 s statement timeout (an expensive request or a loaded database); `53300` the role's connection limit; `08006`, `ECONNREFUSED` and `57P01` the database is away (`docs/runbooks/restore.md` if it stays); `no_window` and `no_display_window` mean the display window has not loaded yet; `attribution_missing` means a body named a source outside the family's source view (a registry fault: keep the log, do not re-deploy over it); `contract` means the body failed its schema (a bug) |
| `X-Stale: 1` on `/api/v1/health` | Saturated and no permit free: the last good body (at most 60 s) is served | §4 |

```bash
sudo docker compose -p rws logs --since 30m api | jq -c 'select(.msg == "api unavailable" or .msg == "limiter" or .msg == "health unavailable")'
```

The log lines carry a fixed code and the route name only, never a driver message, a value or an address.

## 4. Saturation, health and the watchdog

When no DB permit is free the data routes wait at most 250 ms and then answer 503 `busy`. `/api/v1/health` and `/api/v1/health/sources` never wait: they take a permit only if one is free right now. With none free they answer the **last good body, if it is at most 60 s old, with `Cache-Control: no-store` and `X-Stale: 1`**; with no such body they answer 503 `busy` with `Retry-After: 2`. So during a spike the watchdog (which reads `/api/v1/health` through Caddy) sees a stale but valid document and no false "down". A real database error is different: it stays the cached 503 `{"status":"down","error":"unavailable","attribution":[]}` for 5 s, and the watchdog reads it as down.

`X-Stale: 1` for more than about a minute means the API stays saturated: the permits are held by slow computations (look for `57014` in §3), or the traffic is real. Do not raise the permits first: 16 permits already exceed the pool of 10, so up to six computations wait on the pool for its connection timeout. If `53300` or pool waits show, set `RWS_API_DB_CONCURRENCY` equal to the pool size.

## 5. `RWS_API_DB_CONCURRENCY`

A whole number from 1 to 64; unset or empty is the default (16 public, 2 owner). Anything else makes `api` exit 64 at start with a usage line, so a typo never starts an API with an unintended limit. `deploy/compose.yaml` does not set it, so production runs the defaults; to change it add it to the `environment` of the `api` service in a PR and a release, never by hand on the VPS (`docs/runbooks/deploy-rollback.md`). The effect is immediate on restart: a smaller number sheds load sooner (503 `busy`), a larger one lets the database CPU, which `load` shares, take more.

## 6. [owner] Does the API see real client addresses?

The per-client limiter is only as good as the address Caddy hands it. Docker's userland proxy can show Caddy a **bridge gateway** instead of the visitor for traffic that reaches a published port (the host sets neither `userland-proxy: false` nor `ip6tables` in `daemon.json`). If every client looked like one address, the limiter would be one shared bucket and lock everyone out; so a peer in the private ranges of §2 is `unknown-gw` with buckets 100 times larger, which degrades that case to "barely limited". The CI job `deploy` proves the real prefixes of its runner (IPv4, and IPv6 where available) in the masked access log; the production check is yours, once after the release and after any change of `daemon.json` or the compose networks (KG-228).

```bash
# the prefixes the API traffic came from in the last hour: they must be your visitors' /24 and /48 prefixes
sudo docker exec rws-caddy-1 cat /data/access/access.log \
  | jq -r 'select(.request.uri | startswith("/api/v1/")) | .request.remote_ip' | sort | uniq -c | sort -rn | head
# and the API's own signal: no line means no gateway peer was seen
sudo docker compose -p rws logs --since 24h api | grep -c limiter_gateway_key
```

Make one request from your own phone on mobile data (an IPv4 address) and, if you have one, from an IPv6 network, then look for its prefix in the log. **If the log shows a bridge address** (`172.30.x.0` or a private or `fd7a:7773:…` prefix for every request) or the `limiter_gateway_key` count is not 0: the collapse is real. Do not disable the limiter. Change the Docker daemon settings in `deploy/host/daemon.json` in a reviewed change (`"userland-proxy": false`, and Docker's IPv6 firewalling for the IPv6 case; check the firewall rules of `deploy/host/nftables.conf`, which assume DNAT in `nat PREROUTING`, still hold), run `deploy/host/bootstrap.sh`, restart Docker in a quiet hour, and repeat the check. Record the result in the PR or `docs/known-gaps.md` (KG-228). A prefix of 169.254.0.0/16 or of a custom Docker address pool is not one of the ranges the fail-safe knows: it would be limited as one client.

## 7. `v`, caches and the history window

- **`v`** is an optional parameter of `/snapshot` and `/series/{id}` only: one to six digits, no leading zero (`^[1-9][0-9]{0,5}$`); anything else is a 400. On `/series/{id}/forecast` it is a 400 `unknown_parameter`. The static files name the version of a settled day in their path (`settled/D/v{n}/…`); the same number is `v` here.
- **An answer is `Cache-Control: public, max-age=31536000, immutable` only if** `v` equals the current version of every UTC day it spans, every one of those days is settled (it ended at least 48 hours ago), and the answer holds no series without `history_export`. A request with a stale or no `v` gets the age-class policy: the current bucket `public, max-age=60, stale-while-revalidate=300`, younger than 48 h `public, max-age=600`, older `public, max-age=86400`; `/meta` 60 s, `/stations`, `/openapi.json` and `/series/{id}/forecast` 300 s. The header is chosen per request, so a right `v` never leaves an immutable header on the body a stale `v` receives. The in-process cache keeps an answer for at most a day, never a year.
- The API reads the day versions every 10 s. After a settled day was re-rendered as `v{n+1}` (`docs/runbooks/publisher.md` §2), requests with the old `v` are no longer immutable within 10 s and the cache key has changed; a visitor's browser keeps the old URL's bytes, which never change.
- **The history window.** A series whose source lacks `history_export` is served only inside its `history_window`: the views drop older values, and an answer that holds such a series is cached and sent for at most the time left of the window (`max-age` shrinks, 0 is `no-store`) and is never immutable. This now covers forecast values as well (`20261108000001_views_history.sql`). No source lacks `history_export` today (KG-230); when one does, run `verify-prod.sh` after the release and read `Cache-Control` of an old `/snapshot`.
- `Vary: Accept-Encoding` is set by the API: it sends zstd or gzip when the client accepts them (`Content-Encoding`), and Caddy leaves such a body alone.
- Every answer carries `attribution`: the sources of its body and no others, each with the text, link and date its licence needs. An answer that names a source outside the family's source view is a 503 (`attribution_missing`, §3).

## 8. The beacon

`POST /api/v1/beacon` receives the browser's CSP and Reporting API reports (the site sends `Reporting-Endpoints: csp="/api/v1/beacon"`, and the CSP says `report-to csp`) and our own client errors. The content type must be `application/reports+json`, `application/csp-report` or `application/json`; the body is at most 8 KB; the answer is a 204 with no body. The report is **logged and dropped**: one line `{"msg":"beacon","beacon":"<kind>","fields":{…}}` per report in the `api` log (and `api-owner` for the owner site), with control, bidirectional and zero-width characters removed and every string cut at 200 characters, no client address, nothing in the database.

```bash
sudo docker compose -p rws logs --since 24h api | jq -c 'select(.msg == "beacon") | {beacon, d: .fields["violated-directive"], b: .fields["blocked-uri"]}' | sort | uniq -c | sort -rn | head
```

A CSP report is a defect of ours (a page that loads something the CSP forbids) or a browser extension; look at `blocked-uri` and `violated-directive`, and never open a URL from a report. A flood of beacon lines means abuse: the per-client bucket is 1 a second and all clients together 20 a second, and the logs rotate at 5 files of 20 MB, so a flood costs log history, not the disk. Over the global limit real reports are refused with 429, which is acceptable.

## 9. The owner API (`api-owner`)

The owner API is the same code for the owner family: the same routes, limits, caches and `v` rules, `audience: "owner"` in every body, the owner attribution (SPW, AGE and BfG credits where their sources are in the body), `Cache-Control: private, no-store` on every answer, no export route and, until #26, no `/frames`. It is in `deploy/compose.owner.yaml`, on its own network `owner_edge` shared only with `caddy-owner`, with no published port, and **production does not run it before P12a** (WireGuard, KG-212, KG-226): until then the owner view has only the owner publisher's files.

When the owner overlay is started (P12a): `sudo docker compose -p rws -f deploy/compose.yaml -f deploy/compose.owner.yaml up -d api-owner`; its secret is `db_rws_owner_api` (the same file `publish-owner` reads; restart both after a rotation, `docs/runbooks/bootstrap.md`); like `api` it has the container's node healthcheck and no healthchecks.io slug. Owner `/health` has no loader backlog (KG-219) and an owner body that names LU-3 carries no LU-3 attribution entry (KG-229). Never test it from the public site: a public request for an owner station or series id must answer the same 404 as an unknown id (proven byte for byte in CI), and `verify-prod.sh` greps every public API route and a sample of the settled files for the owner canary and every owner term (`api sweep`, `settled sweep`).

## After this release

Nothing on the host changes: no new host file, healthcheck slug or secret (`api-owner` is in the overlay, which production does not start). Do the check of §6 once, then run `scripts/verify-prod.sh <domain>`: `api sweep` must PASS; `settled sweep` is N/A until a settled day is complete and PASS after. The beacon starts receiving CSP reports (§8).
