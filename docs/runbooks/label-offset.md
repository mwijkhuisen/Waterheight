# Runbook: the LU-1 label offset changed or is unknown

**Trigger:**
- a `load` log line with `"alert":"label_offset_changed"` (fields `source`, `day`, `from`, `to`) or `"alert":"label_offset_unknown"` (`source`, `day`);
- `scripts/verify-prod.sh <domain>` fails `label offset LU-1` (no `label_offset` in the health document, or the measured day is more than 2 days before the server's own now);
- the twin `perl-lu1-de1-h` or `stadtbredimus-lu1-de1-h` fails with a lag of −15 or +15 (`docs/runbooks/twin-failure.md`).

AGE's CSV (`lu-1-csv`) labels each value with a local time. Until the file changed on 2026-09-30 the labels were 15 minutes late (the 5-day file, 480 labels); since then the 7-day file (672 labels) is on time. The loader stores the value under label T at T − offset, with the offset of the UTC day of the label (`offsetFor` in `apps/server/src/adapters/lu-1/normalise.ts`): the day's own measurement, else the latest measured day before it, else `LABEL_OFFSET_DEFAULT_MIN` (0). A nightly job measures the offset against the public DE-1 Perl series (catalogue §2.6, C14, A§7.4 step 8); it never uses LU-2.

## 1. Read the state

```bash
curl -s https://<domain>/api/v1/health/sources | jq '.sources[] | select(.id == "LU-1") | .label_offset'
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -Atc "SELECT jsonb_pretty(value) FROM app_meta WHERE key = 'label_offset:LU-1'"
sudo docker logs --since 72h rws-load-1 2>&1 | grep '"alert":"label_offset'
```

- `label_offset` is `{day, minutes, n_aligned, share}` for the latest measured day, or `null` until the first night after the deploy (the job runs once per UTC day after 02:00 and measures the last complete day). `minutes` is the offset, `n_aligned` the points compared (at least 48 for a decision) and `share` the part of them that agree (at least 0.9).
- The `app_meta` value is `{"days": {"YYYY-MM-DD": {"minutes": …, "n_aligned": …, "share": …}}}`, the last 60 days. A day that is not in it was not measured, or was `unknown`.
- Each day is measured once. A replay afterwards is not measured again (R-070).

## 2. What the alerts mean

| Alert | Meaning | What follows |
|---|---|---|
| `label_offset_changed` `{day, from, to}` | On UTC day `day` the stored LU-1 Perl series met the DE-1 Perl W series at a shift of one step (15 minutes) from the offset the loads had applied (`from`: the latest measured day before it, or 0). The day's offset is now `to` | The next payloads use `to` for the labels of that day and of every later day without a measurement of its own. Values already stored for `day` keep the old offset until a replay (§3) |
| `label_offset_unknown` `{day}` | The day decided nothing: fewer than 48 aligned points, no shift with a share of 0.9, or another shift within 0.2 of the best (a flat river agrees at every shift), or DE-1 Perl or LU-1 Perl has no rows that day. Nothing is stored for the day | The offset carried forward stays in force. One such day is harmless. Several in a row mean DE-1 Perl W or LU-1 is not loading (`docs/runbooks/recorder-down.md`, `docs/runbooks/schema-drift.md`), and `label offset LU-1` fails once the latest measured day is more than 2 days old. A real offset of 30 minutes or more is not found either: only the shifts −15, 0 and +15 are tried, so it shows as `unknown` every night |

## 3. Apply a changed offset to the stored values

The new offset reaches the database only by a replay, never silently. A replay re-parses the archived payloads with today's measured offsets (`labelOffsetsOf`), and the payload that holds a point rewrites it, one `obs_revision` per moved value. It applies the same load windows as the tail, and it never removes a point: a point that no payload in the range states under the new offset keeps its old value. So run it from the manifest day before `day` (the first payloads of the range then still use an offset that did not change, and the edge of the range holds no stale point) to today (every later day without a measurement of its own takes the new offset too).

1. Count first, with the `rwsc` function of `docs/runbooks/replay.md` §2 (it writes nothing):

   ```bash
   rwsc run --rm --no-deps -T load replay --source LU-1 --from <day − 1> --to <today> --dry-run
   ```

2. Run it, then run it a second time: the second run must print `"n_new":0,"n_changed":0`.

   ```bash
   rwsc run --rm --no-deps -T load replay --source LU-1 --from <day − 1> --to <today>
   ```

3. Check that the pair is back: `curl -s https://<domain>/api/v1/health/sources | jq '.twins[] | select(.id | startswith("perl-lu1"))'` shows `lag_min` 0 once the rows of the 24-hour window are right (`docs/runbooks/twin-failure.md` §5).

A replay over days that were measured differently uses each day's own offset, so the days before the change are unchanged. Count the revisions a replay wrote (`n_changed`) before you trust it.

## 4. If AGE changes the offset for good

Nothing to do for the days that follow: the detector measures the day after the change, the next payloads use the new offset and the history keeps the offset of each day. Replay the transition (§3) once. If the new offset is not −15, 0 or +15 minutes from the old one, the detector cannot see it (§2): open an issue with the numbers of one day (`median_delta` of the Perl twin, the labels of the CSV), because the fix is a reviewed code change (`OFFSET_SHIFTS` in `apps/server/src/load/label-offset.ts`), not a setting.

`LABEL_OFFSET_DEFAULT_MIN` is the offset of a day when nothing was measured before it. It is 0 because the format since 2026-09-30 is on time (it was 15 for the old file: catalogue C14). Changing it is a reviewed PR with a bump of the LU-1 adapter `version` in `apps/server/src/load/adapters.ts` and a replay; do not change it for one bad day, which is what the measurement is for.

## What not to do

- Do not edit `app_meta` `label_offset:LU-1` by hand to force an offset: the detector writes it, and a hand-written day is never measured again.
- Do not replay a range you have not counted with `--dry-run`.
- Do not use the owner-audience LU-2 series to decide the offset: owner data never corrects a public value (A§7.4 step 8, invariant 11).
