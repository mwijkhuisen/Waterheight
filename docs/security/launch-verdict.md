# Launch security verdict (P12b, issue #27)

Status: reviewed 2026-10-11, head 3234aef, security review R2 (fresh session). Scope: the P12b diff and the state it leaves production in. The merge verdict is separate from the launch verdict.

| Section | Verdict | Findings |
|---|---|---|
| 1. Permission gate | pass | SR-9 low (GATED is a hand list), SR-10 low (TODO accepted in strings), SR-12 info |
| 2. Owner data stays out of public outputs | pass | none (owner.caddy untouched; robots, sitemap and OG hold fixed paths and RWS_DOMAIN only) |
| 3. Launch phase switch | pass | SR-11 low (robots.txt disallows only /api/) |
| 4. Restore and rebuild drills | pass with findings | SR-3 medium (disk), SR-4 low, SR-5 low, SR-6 low, SR-8 low |
| 5. Alert drill and RWS_CAPTURE_SKIP | pass | none |
| 6. Hardening, CSP, egress, WireGuard-only owner site | pass | none new; SR-1 is a settings finding |
| 7. Privacy | pass | none |
| 8. Dependencies and secrets | FAIL | SR-1 high (B1/B2 not applied), SR-2 medium (CodeQL, test only), SR-7 medium (R-095, Caddy at launch) |

## Overall
Merge prelaunch (both switches off): yes once SR-2 is fixed or dismissed; fix or accept SR-3 before the owner's first --force drill.
Launch (E4): NOT YET. Blocked by SR-1 (owner runs scripts/gh-settings.sh until --check is clean) and SR-7 (Caddy at least 2.11.7 deployed). CAA must be confirmed by the owner (no tooling).
Reviewer: Sonnet 5.5, security review R2. Date: 2026-10-11.

## Round 1 fixes (2026-10-11)

The table above is the review record and is kept as written. The PR fixed these findings; SR-1 and SR-7 are owner actions and stay open as launch preconditions in `docs/launch-checklist.md` section 4.

| Finding | State | What changed |
|---|---|---|
| SR-2 (= CR-2) | fixed | `test/launch-phase.test.ts` compares `new URL(u).host` and escapes every regex metacharacter, `\` included |
| SR-3 | fixed | `rws-restore-drill` sizes the room from the live database and a disk watcher aborts the run above 90 % use (fail code `disk`); R-099 re-rated Medium |
| SR-4 | fixed | the scratch tree rejects non-regular entries and symlinks, the dump is checked with `! -L`, ownership changes use `chown -h`, and the dump and `globals.sql` are opened as file descriptors under the backup lock, so a later path swap has no effect |
| SR-5 (= CR-4) | fixed | `docs/runbooks/vps-rebuild.md` section 4 has the drill row `RWS_SITE_PHASE=prelaunch` and checks it; the E4 flip needs no CI or `run.sh` change |
| SR-6 | fixed | the bucket probe of `rebuild-check.sh` runs only with `--production` and a passing `domain` row |
| SR-8 | fixed | `ops_update` records a drill after part 2 has run |
| SR-9 (= CR-13) | fixed | the gate also covers every source whose baseline licence kind is not open |
| SR-10 | fixed | a permission record whose string fields say `TODO` is refused |
| SR-11 | fixed | `robots.txt` also disallows `/tiles/`, `/data/` and `/downloads/` |
| SR-12 | recorded | the DE-2 flip PR states that owner-period DE-2 runs become public history, within the granted `history_export` channel (PHASES section 44.1, E1) |
| SR-1 | open, owner | run `scripts/gh-settings.sh` until `--check` is clean, confirmed with an admin token (KG-333, KG-025, R-002) |
| SR-7 | open, owner | Caddy 2.11.7 or newer deployed (#131) and Grype re-run (KG-334, R-095) |
| CAA | open, owner | the zone's `CAA` record allows `letsencrypt.org` only; no tooling (KG-335) |
| CR-1, CR-3 to CR-12, CR-14 | fixed or recorded | CR-3 DNS before `rws-deploy` in the rebuild runbook, CR-5 and CR-14 the DST runbook, CR-6 and CR-12 the alert pages, CR-8 the expected drill FAILs, CR-11 the date-blind fallback test; code items (CR-1, CR-2, CR-7, CR-9, CR-10) in the code commits |
| CR-15 | none | the restore drill's duration is unmeasured (KG-322) |

Launch (E4) stays NOT YET until the owner clears SR-1 and SR-7 and confirms CAA.
