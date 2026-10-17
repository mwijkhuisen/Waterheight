# Capacity

Two parts. The year-1 disk and bucket projection is written by `scripts/verify-prod.sh <domain> --capacity --out docs/capacity.md` from production capture data (issue #16) and is not committed until a run has two complete UTC days. The egress budget below belongs to P12a (issue #27); `--capacity` rewrites everything around it and keeps the block between the markers.

<!-- egress:begin -->
## Egress budget (P12a, issue #27; decision D20)

Generated from `docs/capacity-egress.json` by `node scripts/lib/capacity-egress.ts`; edit the JSON and re-run it, not this block (`scripts/verify-prod.sh --capacity` keeps it).

Profile: one cold-cache map session (open the map, zoom, pan, 2 station panels, 5 timebar steps, 1 day of playback), measured by `apps/web/e2e/egress.spec.ts` as bytes on the wire (headers and body, compressed, as transferred), at 2026-10-10T20:14:11.902Z. Compose stack: the tiles are a Lobith fixture and the data a synthetic seed, so this is a regression guard, not a production forecast of the bytes.

| Class | Requests | Bytes (MB) |
|---|---:|---:|
| tiles | 43 | 2.92 |
| assets | 53 | 1.12 |
| data | 14 | 0.43 |
| api | 4 | 0.00 |
| html | 1 | 0.00 |
| other | 1 | 0.00 |
| **Session** | 116 | **4.47** |

CI fails when the session total grows by more than 20% over the baseline; a class above 20% is reported (WARN), because the classes move with the time of day between runs (`EGRESS_UPDATE=1` rewrites the baseline; the change is reviewed like any other). A cold cache is the worst case: a returning visitor re-fetches no hashed asset. The session has no dwell time, while an open live view re-polls its data every 60 s, so the figures below are a lower bound for long visits (review CR-7).

### Inputs

| Input | Value | Source |
|---|---:|---|
| VPS uplink (Mbit/s) | **OWNER: A3** | owner, from the plan ordered in A3 (order minimum: 1000) |
| Monthly traffic quota (TB) | **OWNER: A3** | owner, from the plan ordered in A3 (order minimum: 20) |
| Sessions per hour at the flood-day peak | 20,000 | ASSUMPTION, owner confirms |
| Hours of a flood day at that rate | 12 | ASSUMPTION |
| Flood days in the worst month | 3 | ASSUMPTION |
| Sessions on an ordinary day | 3,000 | ASSUMPTION |
| Burst factor (peak minute against the hourly mean) | 2 | ASSUMPTION |

### Result

| Item | Value | Against the plan |
|---|---:|---|
| Flood-day peak egress | 397.6 Mbit/s | **OWNER: fill in `inputs` of `docs/capacity-egress.json` (A3)** |
| Worst month | 3.62 TB (810,000 sessions) | **OWNER: fill in `inputs` of `docs/capacity-egress.json` (A3)** |

Verdict: not decided until the owner fills in A3.

### Rule (D20)

If the flood-day peak exceeds 50% of the uplink **or** the month exceeds 50% of the traffic quota, arm a CDN pull zone for `/tiles/*` and `/assets/*` only (static, licence-neutral) under the same hostname, following `docs/runbooks/cdn-break-glass.md`, and name the CDN on the privacy page before it goes live. **Never switch to OpenFreeMap or any other third-party tile host**: that adds third-party browser requests (invariant 7) and changes the CSP.
<!-- egress:end -->

## Tunnel mode (#109, ADR-0021)

The block above is measured against the origin's own uplink and is not regenerated for the tunnel. With `RWS_EDGE=tunnel` (`docs/runbooks/edge-switch.md`) Cloudflare carries the egress of the cached trees: `/assets/*` and `/data/*` are answered at its edge once cached, and the origin sees one request per object and edge location instead of one per visitor. The tiles bypass the cache (cache rule 1: `Range` on a cold miss of a cacheable object is dropped, and our tile routes answer 416 without one), so `/tiles/*`, the API and the pages still use the home line's uplink; in the egress table above the tiles row (43 of 116 requests, 2.92 of 4.47 MB per session) is the part the tunnel does not take off the line. Uncached tile ranges are also the part Cloudflare's Service-Specific Terms ("disproportionate large files", 2026-09-28) can be read against (R-103). The D20 rule above still decides when more is needed; in tunnel mode there is no pull zone to arm, and R2 or any other tile host stays out (invariant 7).

## RWS capture archive growth until P16b (P16a, #64)

The three P16a observation specs have no loader entry until P16b, so their payloads are archived and **not pruned** (the pruner deletes only payloads whose batch parsed `ok`, and such a line writes no batch). Sizes are measured on the committed fixtures, one request each; zstd -3 is per object.

| Spec | Requests a day | Raw (B) | zstd (B) | MB a day raw / zstd |
|---|---:|---:|---:|---:|
| `nl-1-obs-sea` | 3,888 | 6,275 | 894 | 24.4 / 3.5 |
| `nl-1-obs-wide` | 4,416 | 11,298 | 940 | 49.9 / 4.2 |
| `nl-1-obs-slow` | 4,968 | 11,604 | 916 | 57.7 / 4.6 |
| `nl-1-hwlw` | 83 | – | – | 0 while it answers 204 |
| **Total** | 13,355 | | | **131.9 / 12.2** |

That is about 4.0 GB a month raw and 365 MB a month in the archive (zstd), on top of `nl-1-astro` (about 35 MB a month, kept forever; KG-363). P16b's loader and the pruner end the growth of the observation payloads.
