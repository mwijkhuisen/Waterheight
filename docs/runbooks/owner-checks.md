# Owner checks of P1 (issue #16)

The `[owner]` acceptance items of P1b, and the ones P1a and P1b share, each with the command or checklist that proves it. Paste each output into #16. Run them after the first successful deploy and backup (`docs/runbooks/bootstrap.md`). §8 to §10 are the `[owner]` items of P2b (issue #17): paste their output into #17, after the P2b release is deployed (`docs/runbooks/bootstrap.md`, "the release with P2b"). §11 is the `[owner]` item of P3 (issue #18): paste its output into #18, after the P3 release is deployed and bootstrapped (`docs/runbooks/bootstrap.md`, "the release with the basemap job"). §12 holds the `[owner]` items and the new `verify-prod.sh` checks of P5b (issue #20): paste their output into #20, after the P5b release is deployed.

## 1. Reachability from the VPS over IPv4 and IPv6 (R7)

```bash
ssh ops@<domain>
rws-reachability --out /tmp/reachability.md    # as ops, not root; about 40 targets × 2 families
cat /tmp/reachability.md
```

- Every **required** row must be PASS, or `n/a (no AAAA)` for IPv6.
- A required FAIL goes into `docs/risk-register.md` with its fallback.
- The optional rows (R7 re-tests) are information only.
- Paste the table into #16. The agent commits it as `docs/reachability-<date>.md`.

## 2. Negative deploy

After at least two releases have been deployed:

```bash
sudo /usr/local/lib/rws/deploy/tests/negative-deploy.sh --dry-run
sudo /usr/local/lib/rws/deploy/tests/negative-deploy.sh
```

Expected output: four PASS lines.

1. An unsigned image is refused.
2. An image signed by another identity is refused.
3. The current release's image verifies.
4. The injected smoke failure rolls back to the older release, and it ends by restoring the newest one.

Capture restarts three times, a few minutes in all.

## 3. Object Lock: the VPS key cannot remove history

```bash
sudo /usr/local/lib/rws/deploy/tests/object-lock-prune.sh
```

It runs `restic forget --prune` with the VPS key on a throwaway prefix (`lockcheck-<time>/`). Then, over the S3 API, it expects five PASS lines:

- the bucket's default retention is COMPLIANCE for at least 30 days;
- a new object version is retained in COMPLIANCE for at least 29 more days;
- every object version is still listed;
- a versioned DELETE is refused;
- shortening a retention is refused.

The prefix stays for the retention period (30 days, a few KB).

## 4. The phone alert (P1a + P1b)

```bash
sudo docker compose -p rws stop capture
```

Wait for the first alert, which comes after about 30 minutes: `cap-lu` has a 5-min cadence, so it alerts at 15 min, and `cap-nl`, `cap-de6`, `cap-ch` and `cap-owner` at 30 min. Then:

```bash
sudo docker compose -p rws start capture
```

- [ ] the alert reached your phone (name the check and the time in #16);
- [ ] the check turned green again within one cadence of the restart.

## 5. Reboot

```bash
sudo reboot
# about 20 minutes later, from anywhere:
curl -s https://<domain>/status/capture.json | jq .generated_at     # < 2 min old
scripts/verify-prod.sh <domain>                                      # all PASS
```

Checklist:

- [ ] no manual step after the reboot;
- [ ] `capture.json` fresh within 20 min;
- [ ] `ssh ops@<domain> systemctl list-timers 'rws-*'` shows the timers scheduled;
- [ ] the `update`, `watchdog` and `backup` checks are green again.

`interval CH-1` is the one check that may FAIL here without a fault (KG-125). It reads the shortest gap between two requests of one spec and variant over 24 h (`min_interval_s`): river and lake are two LINDAS downloads seconds apart every 10 minutes, measured per variant (whether BAFU counts them as one download is asked in C13). After any recorder restart (a reboot, a deploy), a tick the recorder missed runs once as a catch-up 15 s after the start, so the gap to the next regular tick is under 10 minutes (about 9 when the stop spanned a tick). The check then fails until that gap leaves the 24-hour window. Note the restart time in #16; a FAIL long after a restart is a real finding.

The chain: `rws-firewall` loads before Docker, which `Requires=` it. Docker restarts the `unless-stopped` containers (non-local bind covers the IPv6 address that is still tentative at boot). `rws-resolvers` refills the container DNS allowlist once the network is online. Capture writes `capture.json` within a minute, and `rws-status-copy.path` publishes it. The `Persistent=true` timers catch up.

## 6. The forced restore drill

```bash
sudo rws-restore-drill --force
curl -s https://<domain>/status/ops.json | jq .drill       # sampled 100, matched 100
```

## 7. Capacity: the owner-audience aggregate (for the `--capacity` docs PR)

`verify-prod.sh --capacity` sees only public specs. Add the owner specs as one number, never per spec:

```bash
sudo jq --arg today "$(date -u +%F)" \
  '[.days[] | select(.date < $today)] as $d | ([$d[].bytes[]] | add) / ([$d[].date] | unique | length) | floor' \
  /srv/rws/owner/status/capture.json      # complete UTC days only
```

Give the agent that number for `--owner-bytes-per-day`.

## 8. The outage drill (P2b, issue #17)

The `[owner]` criterion: stop capture for 2 hours, start it again, and show that Q7 reports **0 missing buckets** for the tier-1 DE-1 and NL-1 series over the outage.

```bash
ssh ops@<domain>
sudo rws-drill stop-capture 2h --dry-run     # checks the duration and prints the plan
sudo rws-drill stop-capture 2h
```

The full procedure, the alerts to expect, the wait of at least one hour after the restart and the check command it prints are in `docs/runbooks/outage-drill.md`. Do not start it at 02:17 UTC (the nightly dump). Paste the `rws-drill` output and the two `"pass": true` objects of the check into #17.

- [ ] `rws-drill` printed the outage window and, after the wait, the check printed `"pass": true` for `DE-1` and for `NL-1`;
- [ ] the `cap-*`, `watchdog` and `update` checks turned green again after the restart (name any that did not).

## 9. The Actions variables and the first contract check (P2b)

`RWS_DOMAIN` and `RWS_CONTACT_EMAIL` as repository Actions **variables** (not secrets), then start `contract-check` once by hand: `docs/github-settings.md`, "Actions variables and the contract check".

```bash
gh variable list
gh workflow run contract-check
gh run list --workflow contract-check --limit 1
```

- [ ] both variables are listed;
- [ ] the run is green (eight requests since P5b, scheduled at 03:29 UTC: `de-1-basin`, `nl-1-obs-key`, `nl-2-wfs`, `fr-1-obs`, `ch-1-lindas`, `ch-2-pq`, `de-7-messwerte`, `lu-1-csv`; six until P5b and three until P5a), or its issue "Contract drift: the nightly live check failed" names a real drift (`docs/runbooks/schema-drift.md` §7; `fetch_*` on all eight specs points at the runner: R-057).

## 10. The 7-day twin soak (P2b)

After the Eijsden-grens twin (TAW − NAP = 233 ± 1 cm) has run for 7 days, from a checkout:

```bash
scripts/verify-prod.sh <domain> --soak
```

- [ ] `twin eijsden-grens-taw-nap` passes: listed in `/api/v1/health/sources`, its latest check at most 2 hours old, aligned timestamps, `ok`, `failed_7d` 0 and `checks_7d` at least 160 (of 168 hourly checks).
- [ ] (P5b) the same for the six pairs that join it: `chooz-fr3-fr1-h`, `uckange-fr3-fr1-q`, `basel-ch1-de1-h`, `perl-lu1-de1-h`, `stadtbredimus-lu1-de1-h` and `grevenmacher-lu1-de1-h`, each with a lag of 0 (`--soak` prints one `twin <id>` line per pair). A pair that is not listed yet is a FAIL, not a skip. A failing pair: `docs/runbooks/twin-failure.md`.

## 11. The basemap extract on the VPS (P3, issue #18)

The `[owner]` criterion: the extract job ran on the VPS, the log is attached and the sha256 matches the manifest. Two runs on two builds, so that `manifest.json` lists a current and a previous version (the `[agent-prod]` criterion needs both).

```bash
ssh ops@<domain>
sudo rws-basemap-refresh --dry-run 2>&1 | tee ~/basemap-0-dry-run.log                 # the plan; writes nothing
sudo rws-basemap-refresh --build <an older listed build> 2>&1 | tee ~/basemap-1.log    # the list: docs/runbooks/basemap.md §3
sudo rws-basemap-refresh 2>&1 | tee ~/basemap-2.log                                    # the newest build
cd /srv/rws/tiles && sudo jq -r '(.current, (.previous // empty)) | .basemap, .planet | "\(.sha256)  \(.file)"' manifest.json | sudo sha256sum -c -
```

The full procedure, the failure codes and the rollback are in `docs/runbooks/basemap.md`. Paste the three logs and the `sha256sum -c` output into #18.

- [ ] both refresh runs ended with `basemap refresh done (the role's lines above say whether a build was promoted)`, and each logged the role's `promoted` line with its build;
- [ ] `sha256sum -c` printed `OK` for all four files (`basemap-` and `planet-z6-` of both builds);
- [ ] `systemctl list-timers 'rws-*'` does not list `rws-basemap-refresh` yet (enable it only after this check, `docs/runbooks/basemap.md` §7).

## 12. DE-7, LU-1 and the twins (P5b, issue #20)

The `[owner]` items of P5b and the checks that `scripts/verify-prod.sh <domain>` gained. Run them after the P5b release is deployed and bootstrapped, and after the replays of `docs/runbooks/replay.md` §8 (Action D2).

1. **The replays** (`replay.md` §8): DE-7, DE-8, LU-1 and LU-6 from the first manifest day, `--dry-run` first, and each a second time (`"n_new":0,"n_changed":0`). Note the time the `pegeldaten` seed took and paste the JSON lines into #20.
2. **The checks** (from a checkout of this release):

   ```bash
   scripts/verify-prod.sh <domain>
   ```

   - [ ] `health DE-7`, `health LU-1`, `tier-1 DE-7`, `tier-1 LU-1`, `coverage DE-7` and `coverage LU-1` pass (`coverage.ratio` at least 95 % of the expected buckets since the seed);
   - [ ] `fresh DE-7` (a value no older than 90 minutes at `meta.now`) and `fresh LU-1` (75 minutes) pass;
   - [ ] `interval DE-7` passes: it reads the shortest gap between two `de-7-messwerte` requests in 24 hours and wants at least 895 s (900 s less 5 s of jitter). It prints 3600 while the spec is hourly. Like `interval CH-1` (§5) it can FAIL for up to 24 hours after a recorder restart that ran a catch-up (KG-125);
   - [ ] `bytes DE-7` passes: no UTC day of `/status/capture.json` (today, partial, and the two days before) holds more than 90 MB of zstd bytes for `de-7-messwerte`; hourly it is about a quarter of that;
   - [ ] `label offset LU-1` passes once the first nightly job (after 02:00 UTC) has measured a day: the `label_offset` of LU-1 in `/api/v1/health/sources`, not older than 2 days before the server's own now. The detail prints the day, the minutes (0 is expected: AGE's labels are on time since 2026-09-30), the instants compared and their share. Any offset passes; a different one is `docs/runbooks/label-offset.md`;
   - [ ] `api meta` and `api stations` list DE-7 and LU-1 (`API_SOURCES`).
3. **The twins after 7 days**: §10, now seven pairs.
4. **DE-7 every 15 minutes** (KG-135): the plan runs `de-7-messwerte` every 15 minutes once the retention pruner is applied (KG-062); until then it is hourly, and `apps/server/test/capture/budget.test.ts` fails if the cron and the `RWS_PRUNE_APPLY` switch of `deploy/compose.yaml` disagree. When you enable the pruner, the same PR moves the cron; afterwards `interval DE-7` prints about 900 s and `bytes DE-7` is the check that the day stays within 90 MB.
5. **The fall-back night** (KG-133, issue #55): after 03:30 UTC on 2026-10-25, run the read-only export script (in #55's body, and `C:\temp\p5b-dst-export.sh`) on the VPS as `ops` (it writes only under `$HOME`; public sources only: DE-1, NL-1, NL-2, FR-1, CH-1, DE-7 and LU-1) and give the archive to the agent: `scripts/import-fixtures.ts` imports the payloads as the fixtures `apps/server/test/adapters/dst-2026-10-25.test.ts` waits for, and the same PR removes each source from its `PENDING` list.
6. **Licence questions** (no blocker): the Service de la navigation gauges in the AGE file (KG-137) go with the C4 e-mail (`docs/permissions.md`), and the four DE-7 gauges of other operators and the 32 DE-7 gauges that the hydro file does not list (KG-136) go into the optional LANUK notice (`docs/legal/requests/optional-lanuk.md`). Record the answers in `docs/permissions.md`.
