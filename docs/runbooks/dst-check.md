# Runbook: the DST nights (2026-10-25, 2027-03-28 and 2027-10-31)

**Trigger:**
- the night of **2026-10-25** (fall back; the first of the three, passed: its archived payloads are the regression set of `apps/server/test/adapters/dst-2026-10-25.test.ts`, #55), of **2027-03-28** (spring forward: 02:00 to 03:00 local time does not exist) and of **2027-10-31** (fall back: 02:00 to 03:00 local time happens twice), all at 01:00 UTC;
- a `time_dst_gap` or `time_dst_overlap` quarantine, or a `dst_gate` alert, at any other time.

Sources with an offset-less local time (`naive-local`, `local-labelled-z`, `start-of-interval`: LU-1, NL-2, the DE-1, DE-6 and DE-3 adapters) are the ones at risk. The rest state UTC or an explicit offset. **What shows in production, and what does not.** An adapter drops a label that does not exist (`dst_gap`) or is ambiguous (`dst_overlap`) and counts it in the `dropped` map of its normalise result (DE-6, NL-2, LU-1); these codes are **not** alerted, stored or in any health field, so nothing on the host reports them. What does show is a payload that the parser refuses: it is quarantined with the error `time_dst_gap`, `time_dst_overlap` or (LU-1) `time_axis`, which appears as `quarantined` on the source and as an entry of the top-level `quarantined_batches` of `/api/v1/health/sources` (`docs/runbooks/schema-drift.md` §2). The checks below therefore read the quarantines, the freshness and the outage, not the drop counts. The fall-back night of **2026-10-25 was the first real one**: the owner exported its payloads afterwards, and its 26 payloads are the regression set of `apps/server/test/adapters/dst-2026-10-25.test.ts` (#55, `PENDING` empty; no adapter needed a change). The 2027 nights take the same export.

## 1. Before the night

```bash
grep -n -A12 'export const DST_PROOF' apps/server/src/load/adapters.ts
n=$(sudo docker logs rws-load-1 2>&1 | grep -c '"alert":"dst_gate"'); echo "dst_gate lines: $n"; test "$n" -eq 0
```

Expected: a `DST_PROOF` entry with a fall-back and a spring-forward fixture for every gated spec, and `dst_gate lines: 0` (the `test` exits 1 otherwise: a line means a spec is not loaded at all, `docs/runbooks/schema-drift.md` §4). The gate is a build-time declaration; nothing on the host can switch it.

## 2. The morning after

Set `night` to the UTC day of the night (`2026-10-25`, `2027-03-28` or `2027-10-31`). Each command exits non-zero when its condition does not hold.

```bash
night=2026-10-25
# every spec has succeeded within three cadences plus an hour
curl -s https://<domain>/status/capture.json | jq -e '
  now as $n | [.specs[] | select(.last_success == null or ($n - (.last_success[0:19] + "Z" | fromdate)) > 3 * .cadence_s + 3600)] | length == 0'
# no source with a quarantine or an outage, and no payload fetched on or after the night quarantined
curl -s https://<domain>/api/v1/health/sources | jq -e --arg night "$night" '
  ([.sources[] | select(.quarantined > 0 or .outage != null)] | length == 0)
  and ([.quarantined_batches[] | select(.fetched_at >= $night)] | length == 0)'
# the log lines of the night: quarantines for time codes, the DST gate, the label offset
n=$(sudo docker logs --since 12h rws-load-1 2>&1 | grep -cE 'time_dst_(gap|overlap)|time_axis|"alert":"(dst_gate|label_offset_[a-z_]+)"'); echo "dst log lines: $n"; test "$n" -eq 0
```

Expected: three exit codes of 0 (`jq -e` prints `true`) and `dst log lines: 0`. A failing second command: list the cause with `curl -s https://<domain>/api/v1/health/sources | jq -r '.quarantined_batches[] | "\(.source) \(.spec) \(.fetched_at) \(.error)"'`. A `time_dst_gap` or `time_dst_overlap` quarantine of a **whole payload** is a finding even on the night, because the parser refuses a label rather than dropping it; repair it by `docs/runbooks/schema-drift.md` §2 and §4. A dropped single label (`dst_gap`, `dst_overlap`) leaves no trace but a missing value, and is expected for a payload that really holds the missing or repeated hour. If the run was started again after 12 hours, widen `--since`.

## 3. LU-1 and NL-2 payloads

```bash
curl -s https://<domain>/api/v1/health/sources | jq -e '.sources[] | select(.id == "LU-1") | .label_offset != null'
sudo docker logs --since 12h rws-load-1 2>&1 | grep '"alert":"label_offset'
```

Expected: `true` (LU-1 has a measured `label_offset`; `docs/runbooks/label-offset.md`) and **no** line from the second command (no `label_offset_changed` across the night and no `label_offset_unknown`); `label_offset.minutes` unchanged. LU-1 labels are Europe/Luxembourg wall-clock times: after the fall-back, the repeated hour must not overwrite the first one, and after the spring-forward no value may sit in the gap. NL-2 stores nothing (discovery only), so only its drift report matters.

## 4. If a value is wrong

Repair by a fix in a PR and a replay of the day: `docs/runbooks/replay.md` §2 and `docs/runbooks/schema-drift.md` §5. Never edit stored values and never add a spec to `DST_PROOF` without the two fixtures and their goldens. After the replay, run it a second time: it must print `"n_new":0,"n_changed":0`.

```bash
scripts/verify-prod.sh <domain>
```

Expected: green (it includes `fresh`, `tier-1`, `coverage` and `label offset LU-1` for the sources at risk). Record the night in the issue that tracks it (the 2026-10-25 one is #55).
