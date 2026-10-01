# Owner checks of P1 (issue #16)

The `[owner]` acceptance items of P1b, and the ones P1a and P1b share, each with the command or checklist that proves it. Paste each output into #16. Run them after the first successful deploy and backup (`docs/runbooks/bootstrap.md`). §8 to §10 are the `[owner]` items of P2b (issue #17): paste their output into #17, after the P2b release is deployed (`docs/runbooks/bootstrap.md`, "the release with P2b").

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
- [ ] the run is green (three requests: `de-1-basin`, `nl-1-obs-key`, `nl-2-wfs`), or its issue "Contract drift: the nightly live check failed" names a real drift (`docs/runbooks/schema-drift.md` §7; `fetch_*` on all three specs points at the runner: R-057).

## 10. The 7-day twin soak (P2b)

After the Eijsden-grens twin (TAW − NAP = 233 ± 1 cm) has run for 7 days, from a checkout:

```bash
scripts/verify-prod.sh <domain> --soak
```

- [ ] `twin eijsden-grens-taw-nap` passes: listed in `/api/v1/health/sources`, its latest check at most 2 hours old, aligned timestamps, `ok`, `failed_7d` 0 and `checks_7d` at least 160 (of 168 hourly checks).
