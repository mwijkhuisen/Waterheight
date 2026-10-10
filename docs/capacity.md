# Capacity

Two parts. The year-1 disk and bucket projection is written by `scripts/verify-prod.sh <domain> --capacity --out docs/capacity.md` from production capture data (issue #16) and is not committed until a run has two complete UTC days. The egress budget below belongs to P12a (issue #27); `--capacity` rewrites everything around it and keeps the block between the markers.

<!-- egress:begin -->
## Egress budget (P12a, issue #27; decision D20)

Generated from `docs/capacity-egress.json` by `node scripts/lib/capacity-egress.ts`; edit the JSON and re-run it, not this block (`scripts/verify-prod.sh --capacity` keeps it). **The profile is provisional** (a local estimate; the first CI run of `egress.spec.ts` replaces it).

Profile: one cold-cache map session (open the map, zoom, pan, 2 station panels, 5 timebar steps, 1 day of playback), measured by `apps/web/e2e/egress.spec.ts` as bytes on the wire (headers and body, compressed, as transferred), at 2026-10-10T19:08:13.974Z. Compose stack: the tiles are a Lobith fixture and the data a synthetic seed, so this is a regression guard, not a production forecast of the bytes.

| Class | Requests | Bytes (MB) |
|---|---:|---:|
| tiles | 30 | 1.95 |
| assets | 54 | 0.98 |
| data | 9 | 0.11 |
| api | 13 | 0.02 |
| html | 1 | 0.00 |
| other | 1 | 0.00 |
| **Session** | 108 | **3.06** |

CI fails when the total or a class grows by more than 20% over the baseline (`EGRESS_UPDATE=1` rewrites it; the change is reviewed like any other). A cold cache is the worst case: a returning visitor re-fetches no hashed asset.

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
| Flood-day peak egress | 272.1 Mbit/s | **OWNER: fill in `inputs` of `docs/capacity-egress.json` (A3)** |
| Worst month | 2.48 TB (810,000 sessions) | **OWNER: fill in `inputs` of `docs/capacity-egress.json` (A3)** |

Verdict: not decided until the owner fills in A3.

### Rule (D20)

If the flood-day peak exceeds 50% of the uplink **or** the month exceeds 50% of the traffic quota, arm a CDN pull zone for `/tiles/*` and `/assets/*` only (static, licence-neutral) under the same hostname, following `docs/runbooks/cdn-break-glass.md`, and name the CDN on the privacy page before it goes live. **Never switch to OpenFreeMap or any other third-party tile host**: that adds third-party browser requests (invariant 7) and changes the CSP.
<!-- egress:end -->
