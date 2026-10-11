# Runbook: the DST nights (2027-03-28 and 2027-10-31)

**Trigger:**
- the night of **2027-03-28** (spring forward: 02:00 to 03:00 local time does not exist) and of **2027-10-31** (fall back: 02:00 to 03:00 local time happens twice), both at 01:00 UTC;
- a `time_dst_gap` or `time_dst_overlap` drop, or a `dst_gate` alert, at any other time.

Sources with an offset-less local time (`naive-local`, `local-labelled-z`, `start-of-interval`: LU-1, NL-2, the DE-1, DE-6 and DE-3 adapters) are the ones at risk. The rest state UTC or an explicit offset. The real fall-back night of 2026-10-25 is the reference (`apps/server/test/adapters/dst-2026-10-25.test.ts`).

## 1. Before the night

```bash
grep -n -A12 'export const DST_PROOF' apps/server/src/load/adapters.ts
sudo docker logs rws-load-1 2>&1 | grep '"alert":"dst_gate"'
```

Expected: a `DST_PROOF` entry with a fall-back and a spring-forward fixture for every gated spec, and **no** `dst_gate` line (a line means a spec is not loaded at all: `docs/runbooks/schema-drift.md` §4). The gate is a build-time declaration; nothing on the host can switch it.

## 2. The morning after

```bash
curl -s https://<domain>/status/capture.json | jq -r '.specs[] | "\(.spec) \(.last_success) \(.last_failure_status)"'
curl -s https://<domain>/api/v1/health/sources | jq -r '.sources[] | "\(.id) \(.outage) \(.quarantined_batches // 0)"'
sudo docker logs --since 12h rws-load-1 2>&1 | grep -E 'time_dst_(gap|overlap)|quarantin' | tail -n 10
```

Expected: every spec fresh, no `outage` and no new quarantined batch. A `time_dst_gap` or `time_dst_overlap` drop is **expected** only for a payload that really holds the missing or repeated hour; a quarantine of a whole payload is not (`docs/runbooks/schema-drift.md` §2, §4).

## 3. LU-1 and NL-2 payloads

```bash
sudo docker logs --since 12h rws-load-1 2>&1 | grep '"alert":"label_offset'
curl -s https://<domain>/api/v1/health/sources | jq '.sources[] | select(.id == "LU-1") | .label_offset'
```

Expected: no `label_offset_changed` across the night; `label_offset.minutes` unchanged (`docs/runbooks/label-offset.md`). LU-1 labels are Europe/Luxembourg wall-clock times: after the fall-back, the repeated hour must not overwrite the first one, and after the spring-forward no value may sit in the gap. NL-2 stores nothing (discovery only), so only its drift report matters.

## 4. If a value is wrong

Repair by a fix in a PR and a replay of the day: `docs/runbooks/replay.md` §2 and `docs/runbooks/schema-drift.md` §5. Never edit stored values and never add a spec to `DST_PROOF` without the two fixtures and their goldens. After the replay, run it a second time: it must print `"n_new":0,"n_changed":0`.

```bash
scripts/verify-prod.sh <domain>
```

Expected: green. Record the night in the issue that tracks it (the 2026-10-25 one is #55).
