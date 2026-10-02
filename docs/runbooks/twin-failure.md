# Runbook: a twin check fails

**Trigger:**
- the healthchecks `load` check fails with `load_twin`;
- `/api/v1/health` shows `twins.failing` above 0 and status `degraded`;
- a `load` log line with `"alert":"twin_breach"` (field `twin`: the pair's id);
- `scripts/verify-prod.sh <domain> --soak` fails a `twin <id>` check.

A twin is a second series of one physical gauge, from another feed or in another unit, that the registry declares equal to the primary (or to a mirror) up to a stated relation (`registry/twins.yaml`, A§7.4 step 7). The loader compares the two every minute for the current UTC hour. A failing check sets nothing aside and corrects nothing: both series keep loading. It says that two feeds that must agree do not, and either the provider changed something or we did (a registry factor, a datum, a parser).

## 1. Which pair, and what is wrong

```bash
curl -s https://<domain>/api/v1/health/sources | jq '.twins[] | select(.ok | not)'
```

| Field | Meaning |
|---|---|
| `id` | The pair (§2) |
| `window_end` | The hour the check is for. It covers the 24 hours before it, less the newest 30 minutes (the two sides are fetched by different requests) |
| `n_aligned` | The timestamps both series state in that window. Rows filled from another source's payload (QC bit 512, FR-3 into FR-1) are left out of both sides |
| `median_delta`, `max_delta` | a − b over the aligned timestamps, in the canonical unit (cm or m³/s). `max_delta` is the delta furthest from the expected one. Both are null when `n_aligned` is 0 |
| `lag_min` | The lag found: the minutes added to a's timestamps to meet b's (a side that states each value 15 minutes late has −15). 0 when no shift beats the unshifted share by 0.05 while holding the relation (a flat river agrees at every shift, a constant bias at none); null when `n_aligned` is 0 |
| `ok` | At least `min_share` (default 1: every point) of the aligned points are within the tolerance of the expected delta, and the lag is 0 |
| `checks_7d`, `failed_7d` | The hourly checks of the last 168 hours, and how many of them failed |

What the combinations say:

| You see | Meaning |
|---|---|
| `n_aligned` 0, `ok` false | The pair was checked before and now no instant is stated by both sides in the window: one side has no values (its capture or the loader stalled, or the provider serves only gaps), or the instants no longer coincide (a changed step or offset). A pair that was never checked has no row, so data that has not arrived is no breach |
| `n_aligned` above 0, `lag_min` other than 0 | The values agree at another time. The lag is searched within ± `max_lag_min` (default 60) in 5-minute steps; a lag beyond that shows as `ok` false with lag 0 and a large `max_delta` |
| `n_aligned` above 0, `lag_min` 0, `ok` false | At the same instants the values differ by more than the tolerance for more than `1 − min_share` of the points: compare `median_delta` and `max_delta` with the pair's `expected` and `tolerance` |

## 2. The pairs

`registry/twins.yaml` is the authority; the relation is a − b = `expected` ± `tolerance`.

| Id | a and b | Relation | A failure usually means |
|---|---|---|---|
| `eijsden-grens-taw-nap` | NL-1 `eijsden.grens` H in TAW and in NAP | 233 ± 1 cm | RWS changed a datum or serves one side stale: `docs/runbooks/schema-drift.md` §4 (`twin_breach`) |
| `chooz-fr3-fr1-h` | FR-3 (Vigicrues, `fr-3-twin`, every 6 hours) and FR-1 (Hub'Eau), Chooz H `B720000001` | 0 ± 1 cm | One host is stalled (`fr-3-twin` or `fr-1-obs` in `/status/capture.json`), a unit changed (`unit_mismatch` alerts), or the two feeds use another gauge zero |
| `uckange-fr3-fr1-q` | The same two feeds, Uckange Q `A850061001` | 0 ± 0.001 m³/s | As above; the FR-1 side is l/s times 0.001 |
| `basel-ch1-de1-h` | CH-1 `2289/W` (a level in cm LN02) and the DE-1 Basel mirror (a stage above the gauge zero 240.00 m LN02) | 24,000 ± 1 cm | BAFU or WSV changed the gauge zero or the unit, or one feed stopped. The check shows although b is a mirror, until either side is `off` |
| `perl-lu1-de1-h`, `stadtbredimus-lu1-de1-h` | LU-1 (the AGE CSV) and DE-1, the same gauge (the CSV republishes PEGELONLINE's values) | 0 ± 0.05 cm for at least 99 % of the points | A lag of −15 or +15: the label offset in force is wrong, `docs/runbooks/label-offset.md`. Otherwise one feed stopped or changed a unit |
| `grevenmacher-lu1-de1-h` | LU-1 `SN_Grevenmacher` and DE-1 Grevenmacher UP | 0 ± 3 cm for at least 95 % of the points | The two feeds differ by up to 3 cm by nature (catalogue §2.6); a failure means more than 5 % of the points differ by more, or a lag |

## 3. Find the cause

1. **A side has no values (`n_aligned` 0).** Read `/status/capture.json` for the specs of the pair (`nl-1-obs-key` and `nl-1-obs-twin`; `fr-1-obs` and `fr-3-twin`; `ch-1-lindas` and the DE-1 specs; `lu-1-csv` and the DE-1 specs) and `/api/v1/health/sources` for the source's `status` and `quarantined_batches`. A stopped recorder: `docs/runbooks/recorder-down.md`. A quarantined payload: `docs/runbooks/schema-drift.md`. The alerts `unregistered_method`, `unknown_quality`, `unit_mismatch` and `datum_mismatch` name values withheld from a side (`sudo docker logs --since 24h rws-load-1 2>&1 | grep '"alert"'`).
2. **A lag.** Check the last values and their timestamps on both sides (below). For the LU-1 pairs the offset in force is `label_offset` of LU-1 in `/api/v1/health/sources`; read `docs/runbooks/label-offset.md`.
3. **A constant difference.** Compare the latest values of both series (read-only, on the VPS; the QC filter leaves out gap-fill rows):

   ```bash
   sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
     "SELECT s.source_id, s.provider_key, o.ts, o.value, o.qc FROM obs o JOIN series s ON s.id = o.series_id
      WHERE s.provider_key IN ('<a provider_key>', '<b provider_key>') AND o.ts > now() - interval '3 hours'
        AND (o.qc & 512) = 0 ORDER BY o.ts, s.source_id"
   ```

   The pair's keys are in `registry/twins.yaml`; `SELECT id, relation FROM twin WHERE id = '<id>'` shows the relation the database holds. A difference that stays the same from one instant to the next is a datum, a gauge zero or a unit; one that changes is a feed.

## 4. Decide

| Finding | Do |
|---|---|
| A revision that one side has and the other not yet | Nothing: the newest 30 minutes are left out, and the current hour is recomputed on every pass. A provider that revises later than 30 minutes makes the check flap for an hour (R-058) |
| A side stopped, or its payloads are quarantined | Fix that first (§3 step 1), then replay what was withheld (`docs/runbooks/replay.md`) |
| A unit or factor changed at the provider | `docs/runbooks/schema-drift.md` §4 (`unit_mismatch`), then replay from an instant after the change (`replay.md` §3, KG-074) |
| The provider changed a datum or a gauge zero (a real offset change) | A registry and catalogue question for the owner. If the new relation is right, a reviewed PR changes `expected` in `registry/twins.yaml` with the reason in its comment; `migrate` syncs the twin table at the next deploy and the old `twin_check` rows stay |
| The LU-1 label offset is wrong | `docs/runbooks/label-offset.md` |
| The tolerance was too tight from the start | Change it only on evidence (a week of `median_delta` and `max_delta` of the pair) and say so in the PR. Never widen a tolerance, lower `min_share` or raise `max_lag_min` to silence a check without a reason |

## 5. Verify

```bash
curl -s https://<domain>/api/v1/health/sources | jq '.twins'
scripts/verify-prod.sh <domain> --soak       # the twin <id> rows
```

- `twins.failing` is 0 and the `load` check is green within one watchdog cycle (5 minutes);
- the pair's check is recomputed on every pass for the current hour, so a repaired side turns `ok` within a minute when the values of the 24-hour window are right (a replay rewrites them); otherwise the bad hours leave the window within 24 hours;
- `failed_7d` and the soak criterion (none failed in 7 days, at least 160 of 168 hourly checks) recover only as the failed hours leave the 168-hour window.

## What not to do

- Do not edit `twin_check` rows, the `twin` table or the stored values to make a pair pass.
- Do not widen a tolerance, lower `min_share` or raise `max_lag_min` to silence a check (§4).
- Do not read a check with `n_aligned` 0 as an old result: it is a failing row of its own.
- Do not compare a twin that involves an owner-audience series here: those results go to the owner status only (A§7.4 step 7).
