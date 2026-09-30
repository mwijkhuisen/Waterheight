# Runbook: Outage drill

**Trigger:**
- the P2b `[owner]` criterion of issue #17: `rws-drill stop-capture 2h`, then restart; Q7 (in health) reports **0 missing buckets** for the tier-1 DE-1 and NL-1 series over the window (`docs/plan/PHASES.md` P2);
- after a change to a capture window rule (`window` in `registry/capture.yaml`, an adapter's `capture.ts`) or to the load path, to prove that the refill still works end to end.

The drill stops the recorder (the `capture` container) for a set time and starts it again. On restart the recorder stretches its fetch windows back to the last success (minus an overlap, never further than the spec's `max`) and refills the gap from what the providers still serve. The loader loads the refill from the manifest, and the health API reports the gap of each source as `outage` with the number of expected time buckets that are still empty (query Q7 of `docs/plan/ARCHITECTURE.md` §8). The drill is done when that number is 0 for DE-1 and NL-1.

Only the owner runs it, on the VPS, as root through `sudo` (`rws-drill` is one of the `rws-*` scripts that `bootstrap.sh` links into `/usr/local/bin`).

## 1. What it proves and the rules it keeps

| Rule | Consequence |
|---|---|
| It stops and starts the `capture` service and nothing else; the name is fixed in the script. It uses `docker compose stop` and `start`, so the same container comes back: no recreate, no image change, no other service touched | `db`, `load`, `api`, `caddy` and `watchdog` keep running. Docker does not restart a container that was stopped by hand, and `rws-tick` restarts only containers that Docker reports unhealthy, so nothing starts capture early |
| `<duration>` is `Nm` or `Nh`, from `1m` to `6h`, checked against a fixed pattern before any use | Anything else exits 64 and touches nothing. `--dry-run` checks it and prints the plan: no docker call, no sleep |
| It takes the `rws-deploy` lock without waiting, and holds it until capture runs again | While a deploy or an update holds the lock, the drill refuses (exit 1). While the drill holds it, no release can replace capture mid-drill: `rws-update` finds the lock held, logs `another deploy is running`, exits 0 and does **not** ping `update` (§2). A release that arrives meanwhile is deployed by the first `rws-update` run after the drill. `rws-deploy` waits up to 30 minutes for the lock and then gives up |
| It refuses when capture is not running | A drill on a recorder that is already down would prove nothing, and the restart would hide an incident |
| Every way out starts capture again: the end, an error, Ctrl-C (INT), `kill` (TERM) and a dropped SSH session (HUP). Signals are ignored while it restarts | An interrupted drill never leaves the recorder stopped. If the start itself fails, it logs `error: CAPTURE IS STILL STOPPED …` and exits 1 |
| It logs the UTC instants at which capture stopped and at which the start was issued, and prints them with the check command | Those two instants are the window that §5 compares with the health API |

`SIGKILL` and a reboot skip the restart. The container was stopped on purpose, so Docker keeps it stopped (§6).

**What the 2-hour drill does not prove.** After a gap the recorder asks from its last successful fetch minus the 1-hour overlap, where that starts earlier than its default window (`windowFor` in `apps/server/src/capture/specs.ts`). A 2-hour drill shows that the recorder and the loader recover and leave no gap. It cannot show that the stretch works, because the default windows already hold every value of a 2-hour gap: 3 hours for `nl-1-obs-key` and `nl-1-obs-twin`, 6 hours for `nl-1-obs-other` and `de-1-series` (`registry/capture.yaml`). Q7 reads 0 with or without the stretch. To exercise it, the time from the last fetch before the stop to the first after the restart must be longer than the default window: `rws-drill stop-capture 4h` does that for the 3-hour specs; `6h`, the longest the script allows, does it for all four, but for the 6-hour specs only by the minutes from their last fetch to the stop and from the restart to their next fetch, plus the values a provider published up to an hour late (the overlap). KG-091 tracks this.

## 2. Before you start

1. `rws-drill` is installed: `command -v rws-drill`. The release that brings it also brings changed host files, so `rws-update` pings `update` `/fail` with `host_files_changed` until you run that release's bootstrap, which links it into `/usr/local/bin` (`docs/runbooks/bootstrap.md`, last section).
2. Health is green and nothing is quarantined, and the checks are green on the phone:

   ```bash
   curl -fsS https://<domain>/api/v1/health | jq '{status, quarantined}'
   curl -fsS https://<domain>/api/v1/health/sources | jq '.sources[] | select(.id == "DE-1" or .id == "NL-1") | {id, status, outage}'
   scripts/verify-prod.sh <domain>       # all PASS
   ```

   A quarantined payload or a stalled loader (`docs/runbooks/schema-drift.md`) spoils the result: fix it first.
3. No deploy is pending: `sudo rws-update --dry-run` must not print `dry-run: would deploy <tag>`. If it does, let `rws-update` deploy that release first (it runs every 5 minutes) and wait until it is done. A release deployed right after the drill would recreate capture during the refill.
4. Choose the time. The nightly database dump of `rws-backup` is due at the first hourly run (`:17`) at or after 02:00 UTC, or when the last dump is more than 24 hours old, and it waits at most 25 minutes for the same lock before it fails with `dump_failed`. **Do not let the drill hold the lock at 02:17 UTC.** Leave one hour after the restart for §4.
5. Expect these alerts (healthchecks.io and the watchdog). Or pause the checks for the drill and resume them after it. An alert comes after 3 × the check's cadence without a ping (`deploy/healthchecks.yaml`), counted from the last ping before the stop:

   | Check | When it alerts during a 2 h drill | Turns green again |
   |---|---|---|
   | `cap-lu` | after 15 minutes | within one cadence of the restart |
   | `cap-nl`, `cap-de6`, `cap-ch`, `cap-owner` | after 30 minutes | within one cadence of the restart |
   | `cap-de-fed`, `cap-fr` | after 45 minutes | within one cadence of the restart |
   | `cap-de78`, `cap-bfg` | not within 2 hours (3 hours without a ping); a drill of 3 hours or more fires them | within one cadence of the restart |
   | `watchdog` (`capture_stale`) | 5 to 10 minutes into the drill: `capture.json` is older than 5 minutes and the watchdog runs every 5 minutes | in the first cycle after capture writes `capture.json` again |
   | `update` | 15 minutes into the drill: `rws-update` pings nothing while it finds the lock held | at the first `rws-update` run after the drill (every 5 minutes) |
   | `backup` | only if the drill holds the lock through the dump's 25-minute wait (step 4) | at the next hourly run |

   `load`, `cert`, `disk` and `restore-drill` are not expected to alert: the loader keeps running and has nothing new to load. `scripts/verify-prod.sh` reports `FAIL freshness` while capture is down: do not run it during the drill.

## 3. Run it

```bash
ssh ops@<domain>
sudo rws-drill stop-capture 2h --dry-run     # validates and prints the plan; changes nothing
sudo rws-drill stop-capture 2h
```

Keep the session open for the whole time. It prints two lines when capture stops, and the rest when capture runs again:

```
2026-10-05T07:10:12Z rws-drill: stopping capture for 2h (7200 s); the deploy lock is held until it runs again
2026-10-05T07:10:14Z rws-drill: outage starts 2026-10-05T07:10:14Z
2026-10-05T09:10:14Z rws-drill: outage ends 2026-10-05T09:10:14Z: capture started
outage window (UTC): 2026-10-05T07:10:14Z to 2026-10-05T09:10:14Z
check it once the refill has loaded (at least 1 hour from now), both lines must say "pass": true:
  curl -fsS https://<domain>/api/v1/health/sources | jq --arg from '2026-10-05T07:10:14Z' --arg to '2026-10-05T09:10:14Z' '.sources[] | …'
```

To end the drill early on purpose, press Ctrl-C: capture starts at once and the printed window is the shorter one. If the SSH session drops, the drill ends early in the same way, but its output is lost with the session: note the times from the health API (§5) instead, and say so in the issue. Do not start capture by hand while the script runs.

Exit codes: 0 done, 64 bad arguments, 1 refused (a deploy holds the lock, capture is not running, `rws.env` incomplete) or capture could not be started again.

## 4. Wait

At least **one hour after the restart**. The recorder refills the gap in its next runs (a spec with a `step` takes a long gap in pieces, one per run, oldest first), the loader tails the manifest every 10 seconds, the health numbers are recomputed every minute and the answer is cached for 30 seconds. The gap itself is found by a scan that runs every **10 minutes** (`findOutages` in the loader), so `outage` can show up to 10 minutes after the first payload of the refill is loaded.

- The `cap-*` checks turn green within one cadence of the restart; `watchdog` and `update` within 10 minutes. Note in the issue any that does not.
- The loader must have caught up: `curl -fsS https://<domain>/api/v1/health | jq '.loader'` shows a small `backlog_age_s`.

Check within a day of the drill. `outage` reports only the **last** gap of a source that lasted longer than max(3 × the source's capture cadence, 30 minutes), within the last 168 hours: a later outage replaces it.

## 5. Verify

Run the command that the script printed. It is the same for every drill; only `--arg from` and `--arg to` (the window) change:

```bash
curl -fsS https://<domain>/api/v1/health/sources | jq --arg from '<from>' --arg to '<to>' '.sources[] | select(.id == "DE-1" or .id == "NL-1") | .outage as $o | {id, outage: $o, pass: ($o != null and ($o.from | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) <= ($from | fromdateiso8601) and ($o.to | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) >= ($to | fromdateiso8601) and $o.missing_buckets == 0)}'
```

It prints one object each for `DE-1` and `NL-1`. The drill **passes** when both say `"pass": true`, which means:

- `outage.from` is at or before the window's start, and `outage.to` at or after its end: the gap the health API found is the drill's. `from` and `to` are the **fetch times** (not the load times) of the last payload that the source loaded `ok` before the stop and of the first one after the restart; a payload that was quarantined or skipped does not count;
- `outage.missing_buckets` is `0`: over the tier-1 primary series that had data in the 24 hours before the gap, every expected time bucket from `from − staleness_limit` to the earlier of `to` and `now − staleness_limit − expected_step` has data again. A series that already had no data in those 24 hours is not counted.

**Record the result** in issue #17: paste the `rws-drill` output and the `jq` output. The agent then ticks the criterion in `docs/plan/PHASES.md` and takes the drill out of KG-050 (`docs/known-gaps.md`).

### A source with no pass

| Finding | Meaning | Do |
|---|---|---|
| `outage` is `null` | No gap longer than the threshold within 168 hours: capture did not stop (read the `rws-drill` output, `sudo docker compose -p rws ps`), the refill is not loaded yet or the 10-minute scan has not run since (§4), or the deployed release has no `outage` field (`curl … | jq '.sources[0] | keys'`) | Fix the cause and repeat the check; repeat the drill only if capture did not stop |
| `outage.from` or `outage.to` do not bracket the window | The field shows another gap: a real outage after the drill, or a longer one that the refill has not closed | Read `outage.from` and `outage.to`; if it is a real outage, `docs/runbooks/recorder-down.md`; then repeat the drill |
| `missing_buckets` > 0 | Some expected buckets have no data | Below |

### A non-zero count

List the empty buckets of the source inside the window (Q7 of `docs/plan/ARCHITECTURE.md` §8, limited to one source; `<from>` and `<to>` are `outage.from` and `outage.to`). It is the query of `computeHealth` (`apps/server/src/load/health.ts`) with the buckets listed instead of counted: active tier-1 series with role `primary` that share their source's audience, buckets from `from − staleness_limit` to the earlier of `to` and `now − staleness_limit − expected_step` (`now()` stands in for the time of the health pass), and only series that had data in the 24 hours before `from − staleness_limit`:

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
  "SET TimeZone = 'UTC'; SELECT s.id, s.provider_key, g.b FROM series s
   JOIN source src ON src.id = s.source_id JOIN station st ON st.id = s.station_id AND st.tier = 1
   CROSS JOIN generate_series(date_bin(s.expected_step, '<from>'::timestamptz - s.staleness_limit, '2000-01-01T00:00:00Z'::timestamptz),
     LEAST('<to>'::timestamptz, now() - s.staleness_limit - s.expected_step), s.expected_step) g(b)
   WHERE s.source_id = 'NL-1' AND s.active AND s.role = 'primary' AND COALESCE(s.audience, src.audience) = src.audience
     AND EXISTS (SELECT 1 FROM obs o WHERE o.series_id = s.id AND o.ts >= '<from>'::timestamptz - s.staleness_limit - interval '24 hours'
                   AND o.ts < '<from>'::timestamptz - s.staleness_limit)
     AND NOT EXISTS (SELECT 1 FROM obs o WHERE o.series_id = s.id AND o.ts >= g.b AND o.ts < g.b + s.expected_step)
   ORDER BY s.id, g.b"
```

Then decide which of three causes it is:

1. **The refill is not loaded yet, or the loader has a problem.** `.loader.backlog_age_s` is large, or `quarantined` is above 0 for the source. Wait for the loader, or follow `docs/runbooks/schema-drift.md`; after a fix, `docs/runbooks/replay.md` loads the payloads of the drill's day (`replay --source <ID> --from <day> --to <day>`). Check again.
2. **A gap at the provider.** Only a few series miss buckets, and the same ones miss them in normal operation. Read the archived payload that should cover the bucket: list the batches after the restart, and read the object on the VPS (`docs/runbooks/schema-drift.md` §2).

   ```bash
   sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
     "SELECT id, spec_id, fetched_at, parse_status, archive_key FROM ingest_batch WHERE source_id = 'NL-1' AND fetched_at >= '<to>' ORDER BY fetched_at LIMIT 20"
   ```

   If the payload has no point for that time, or RWS marks it with quality code 99 (a gap, served with the value 0.0), the provider had no data: it is not our fault. Write the series, the buckets and the payload's `archive_key` in the issue; the owner decides whether the criterion holds with them explained.
3. **The recorder did not stretch its window.** Many series of the source miss the same buckets, from the start of the window, and no payload fetched after the restart reaches back that far. Look at `sudo docker logs --since 3h rws-capture-1`, at `/status/capture.json` (`specs[].last_success`) and at the manifest lines of the spec after the restart. The window rule is `window` of the spec in `registry/capture.yaml` (`default`, `max`, `overlap`, `min`, `step`). Fix it in a PR and repeat the drill. `replay` cannot help: it re-reads only what was archived and never fetches.

Do not record a pass for a source whose count is above 0 and unexplained.

## 6. If the script did not finish

`SIGKILL` of the script, or a reboot of the VPS during the drill, skips the restart, and Docker does not restart a container that was stopped by hand. The `cap-*` and `watchdog` alerts tell you. Start it:

```bash
sudo docker start rws-capture-1
```

If the container is gone, `sudo rws-deploy "$(sudo cat /var/lib/rws/current)"` recreates the stack from the current release (`docs/runbooks/recorder-down.md` §2). The lock is released when the script ends, so `rws-update` runs again by itself. Then treat the drill as not done: repeat it.

## What not to do

- Do not stop `load` or `db` in the same window: the check would then measure the loader's catch-up, not the recorder's refill, and the `load` check would alert too.
- Do not edit or delete manifest lines or archived objects to close a gap (`docs/runbooks/schema-drift.md`). The archive is the source of truth.
- Do not run the drill while a deploy is pending or running: it refuses to start beside one, and a release deployed right after it recreates capture.
- Do not stop capture with `docker compose … stop capture` instead of `rws-drill`: it has no lock and no restart on failure.
- Do not start capture by hand before the script ends, and do not run the drill twice within one check window (`outage` shows only the last gap).
- Do not run it at 02:17 UTC (§2, step 4), and do not run `scripts/verify-prod.sh` during it.
