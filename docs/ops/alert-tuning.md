# Alert tuning (healthchecks.io grace values; P12b, issue #27)

State: **tuned from the owner's export `hc-lateness-2026-10-11.json` (2026-10-11, plan §1a.1); every grace stays 2 × timeout.** The export holds at most the last 50 success pings per check (healthchecks.io keeps the last 100 pings), so each window is 8–48 h, not the whole soak. In it the largest lateness over a timeout was 600 s (`cap-nl`, one missed 10-minute tick, half its grace); every other measured check was at most 43 s late. No measured check needs more grace, and the data is too short to justify less, so `deploy/healthchecks.yaml`, `deploy/bin/rws-hc-sync` and `test/healthchecks.test.ts` are unchanged. Eight checks had no success ping in the window (see the table); they could not be measured. Known gap: [U] a longer soak export for those eight.

A check alerts after `timeout + grace` without a ping. With grace = 2 × timeout that is 3 × the cadence of the job.

## The table (all 18 checks)

"Observed p99 lateness" is the p99 of how far past its timeout a ping arrived during the soak. Columns from the export: p99 and max interval between success pings, max lateness = max interval − timeout (floor 0), down = down flips in the window (a `/fail` ping also flips a check down, so down flips are not lateness).

| check | observed p99 lateness | old grace | new grace | reason |
|---|---|---|---|---|
| `cap-nl` | p99 interval 1200 s, max late 600 s (50 pings, 0 down) | 1200 s (20 min) | 1200 s (unchanged) | timeout 600 s: capture group NL (NL-1, NL-2, NL-4); measured lateness below the grace |
| `cap-de-fed` | p99 interval 901 s, max late 1 s (50 pings, 0 down) | 1800 s (30 min) | 1800 s (unchanged) | timeout 900 s: capture group DE federal (DE-1); measured lateness below the grace |
| `cap-de6` | p99 interval 600 s, max late 0 s (50 pings, 0 down) | 1200 s (20 min) | 1200 s (unchanged) | timeout 600 s: capture group DE-6; measured lateness below the grace |
| `cap-de78` | p99 interval 3602 s, max late 2 s (50 pings, 0 down) | 7200 s (2 h) | 7200 s (unchanged) | timeout 3600 s: capture group DE-7, DE-8 (hourly); measured lateness below the grace |
| `cap-fr` | p99 interval 938 s, max late 38 s (50 pings, 18 down) | 1800 s (30 min) | 1800 s (unchanged) | timeout 900 s: capture group FR; measured lateness below the grace |
| `cap-lu` | p99 interval 301 s, max late 1 s (50 pings, 0 down) | 600 s (10 min) | 600 s (unchanged) | timeout 300 s: capture group LU; measured lateness below the grace |
| `cap-ch` | p99 interval 600 s, max late 0 s (50 pings, 1 down) | 1200 s (20 min) | 1200 s (unchanged) | timeout 600 s: capture group CH; measured lateness below the grace |
| `cap-bfg` | p99 interval 3603 s, max late 3 s (50 pings, 0 down) | 7200 s (2 h) | 7200 s (unchanged) | timeout 3600 s: capture group BfG (DE-2, DE-3; hourly); measured lateness below the grace |
| `cap-owner` | no success ping in the window (1 down) | 1200 s (20 min) | 1200 s (unchanged) | timeout 600 s: owner group (BE-3, LU-2, LU-3, LU-4); not measurable from this export |
| `backup` | no success ping in the window (0 down) | 7200 s (2 h) | 7200 s (unchanged) | timeout 3600 s: hourly restic run; not measurable from this export |
| `restore-drill` | no success ping in the window (0 down) | 5356800 s (62 d) | 5356800 s (unchanged) | timeout 2678400 s (31 d): monthly drill; not measurable from this export |
| `update` | p99 interval 343 s, max late 43 s (95 pings, 14 down) | 600 s (10 min) | 600 s (unchanged) | timeout 300 s: update timer; measured lateness below the grace |
| `watchdog` | no success ping in the window (3 down) | 600 s (10 min) | 600 s (unchanged) | timeout 300 s: public-URL watchdog; not measurable from this export |
| `cert` | no success ping in the window (3 down) | 600 s (10 min) | 600 s (unchanged) | timeout 300 s: certificate check (watchdog); not measurable from this export |
| `disk` | no success ping in the window (3 down) | 600 s (10 min) | 600 s (unchanged) | timeout 300 s: disk check (watchdog); not measurable from this export |
| `load` | no success ping in the window (1 down) | 600 s (10 min) | 600 s (unchanged) | timeout 300 s: loader lag, pinged by the watchdog from `/api/v1/health`; not measurable from this export |
| `publisher` | no success ping in the window (1 down) | 1200 s (20 min) | 1200 s (unchanged) | timeout 600 s: pinged by the watchdog from `/data/v1/meta.json`; not measurable from this export |
| `owner-publisher` | p99 interval 626 s, max late 0 s (100 pings, 0 down) | 2400 s (40 min) | 2400 s (unchanged) | timeout 1200 s: pinged by `rws-tick` from the owner `meta.json` mtime only; measured lateness below the grace |

## Tuning rule (applied to the 2026-10-11 export; reapply to a later one)

A change is one commit, from an export only, citing its file name and date at the top of this page.

1. Per check, read the p99 lateness (and the max and down count) from `hc-lateness-<date>.json`. Never use a number that is not in the file.
2. New grace = at least the timeout, and at least the observed p99 lateness plus a margin (state the margin in the reason column). Round up to a whole minute. Keep a grace that is already above that: tuning must not remove headroom a measurement cannot justify. Change a timeout only with a stated reason.
3. A check whose p99 lateness is above its current grace is a cadence problem to explain first (a stuck job, a cron overlap), not to hide with a larger grace; put the explanation in the reason column.
4. Fill the "observed p99 lateness", "new grace" and "reason" columns of every row, the owner group (`cap-owner`, `owner-publisher`) included.
5. The count stays at most 20 (healthchecks.io free plan; 18 today).

Three pins and one text require grace = 2 × timeout. The 2026-10-11 export changed no value, so they stay. A later change relaxes them together with the values, in the same commit (plan §8 A2):

- `deploy/bin/rws-hc-sync` (around line 40): `.grace == 2 * .timeout` becomes `.grace >= .timeout`; `length == 18` becomes `length <= 20` (and the error text and the "18" in the header comment).
- `test/healthchecks.test.ts`: the `grace` is twice the timeout assertion becomes `grace >= timeout` (and the "18 slugs" count and header comment follow).
- the header of `deploy/healthchecks.yaml`: the `grace = 2 × timeout` sentence.
- the A§11.3 text (`docs/plan/ARCHITECTURE.md`), where the check list is described.

After the commit the owner runs `deploy/bin/rws-hc-sync` from the workstation (action A6) to push the new graces, then `deploy/tests/alert-drill.sh` to confirm that every alert still arrives.

## Alert drill

`deploy/tests/alert-drill.sh` (owner, on the VPS, `sudo`) sends a synthetic `/fail` ping to every check of `deploy/healthchecks.yaml`, holds (default 60 s) and then sends a success ping to each, so every check is green again. It induces no outage, and a trap restores the checks on any exit. It prints a receipt table: slug, /fail sent UTC, success sent UTC, and a last column the owner fills in when the alert arrives. `--only <slug>` drills one check; `--dry-run --hc-base http://127.0.0.1:<port>` pings a local stub only (the offline test, `deploy/tests/alert-drill.test.sh`).

The drill proves delivery (integration, mail or phone), not timing: a synthetic `/fail` alerts at once, whatever the grace. The alert delay (`timeout + grace`) is judged from the soak data above. The receipt table is evidence for the launch checklist; [U] real alert receipts: only the owner can confirm them.
