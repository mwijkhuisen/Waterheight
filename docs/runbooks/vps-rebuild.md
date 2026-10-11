# Runbook: rebuild the VPS from the off-site backup (and the E3 drill)

**Trigger:**
- the VPS is lost or untrustworthy (provider incident, disk failure, compromise) and a new one must serve the site again;
- the owner criterion E3 of issue #27 P12b: the **timed rebuild drill**, once before the public launch (target RTO ≤ 4 h, A§11.3), and again after any change to `bootstrap.sh`, the backup layout or `rws-deploy`;
- a restore drill (`rws-restore-drill`) failed in a way that makes you doubt the backups.

This is the one document that strings the others together: `bootstrap.md` (the host), `restore.md` (the data), `replay.md`, `basemap.md`, `geo-refresh.md`, `owner-device.md`, `deploy-rollback.md`. Where a step is long there, this page gives the command and the check and names the section. **Owner only; no agent has production access.**

**The two modes.**
- **Real rebuild**: the production domain, nothing skipped, DNS moved first (§5: the deploy needs a certificate for the production name), the owner site brought back (§11) and the DNS cut-over verified (§12).
- **Drill (E3)**: a second, temporary VPS under its own hostname, the production bucket through a read-only key, no pings, no backups, no owner port, no indexing, and `RWS_CAPTURE_SKIP=CH-1,NL-1` so that it does not spend the providers' budget next to production. Every step says what differs. Fill `docs/drills/rebuild-timing-sheet.md` while you go (it ships empty; never fill it from memory).

**What is and is not in the backup.** One restic snapshot per hour holds `/data/raw` (the raw archive, RPO ≤ 1 h) and `/data/db` (`rws.dump` and `globals.sql`, the nightly dump, RPO ≤ 24 h for the database). **Not in it:** the TLS and ACME state (`caddy_data`; KG-055: Caddy asks Let's Encrypt again), the basemap (`/srv/rws/tiles`), the river files (`/srv/rws/public/data/v1/rivers`, `/srv/rws/public/downloads`), the published tree and the owner tree (the publishers regenerate them), `/etc/rws/secrets` and `/etc/rws/rws.env` (your password manager), the WireGuard server key and peers (§11). The map and the rivers are fetched again (§10).

**D19, the statement to record with every rebuild.** What the providers keep (5 to 40 days; catalogue §0.1) is refilled by the capture gap-stretch windows and by `load`. What nobody keeps is lost for good for the time the VPS was down plus the time since the last snapshot: forecast runs, alert and class states, threshold versions and raw-as-published values (ADR-0003). Payloads that were due while the stack was down are not captured later. Note the window (last snapshot time to the time capture started again, §9) in the daily report.

## The steps and the sheet

The minutes are measured by you, never estimated: copy each row's start and end (UTC) into the sheet. The clock starts when you first log in to the new, empty VPS (**T0**) and stops at the end of §14. Rows that overlap count once (wall clock). Pass: total ≤ 240 min and no Q7 gaps (§14).

| § | Step | Who | Minutes |
|---|---|---|---|
| 1 | Verify the release, run `bootstrap.sh` | owner | TODO (E3) |
| 2 | Secrets (A7) and bootstrap again | owner | TODO (E3) |
| 3 | Quiet the host: timers (and, on the drill, WireGuard) off | owner | TODO (E3) |
| 4 | `rws.env` | owner | TODO (E3) |
| 5 | Real rebuild: DNS cut-over first; `rws-deploy` the verified release; stop `capture` and `load` | owner | TODO (E3) |
| 6 | Restore the snapshot: raw (RPO ≤ 1 h), dump (≤ 24 h) | owner | TODO (E3) |
| 7 | Restore the database (route B) | owner | TODO (E3) |
| 8 | Replay since the dump (the loader catches up) | owner | TODO (E3) |
| 9 | Start capture, load and api again; the D19 window | owner | TODO (E3) |
| 10 | The basemap and the river files | owner | TODO (E3) |
| 11 | WireGuard and the owner site (real rebuild only) | owner | TODO (E3) |
| 12 | DNS check and TTL restore (real rebuild; the drill's own name exists before T0) | owner | TODO (E3) |
| 13 | `verify-prod.sh <domain> --profile …` | owner | TODO (E3) |
| 14 | The Q7 gap check (and `rebuild-check.sh` on the drill) | owner | TODO (E3) |

## Before the clock starts

1. **A fresh Debian 13 amd64 VPS** as in `bootstrap.md` §0 (A3), your SSH key installed. For the **drill**, also:
   - a hostname that is not production's, e.g. `drill.<your domain>`, with `A` and `AAAA` records to the drill VPS (the `CAA` record of the zone already allows Let's Encrypt). It must be a valid `RWS_DOMAIN` (lower case, a real domain). Let's Encrypt allows five certificates a week for one exact hostname: use a new name when you repeat the drill;
   - a **read-only bucket key** (get and list on the bucket, no put, no delete) from the provider, never the VPS key of production (which may put and delete) and never the workstation key. Create it for the drill and delete it after;
   - the drill is **never indexed**: it must serve the prelaunch phase (`X-Robots-Tag: noindex`). `rebuild-check.sh` fails `noindex` otherwise.
2. **For a real cut-over (planned rebuild, or this drill's cut-over practice): lower the TTL 24 hours before.** Set the TTL of the `A` and `AAAA` records of the production domain to 300 s a day ahead, so the move at the start of §5 takes minutes to propagate. A real disaster has no such lead time: then the TTL you had is the time you wait.
3. Have ready: the password manager entries for every secret of `bootstrap.md` §3, the restic repository password, the bucket endpoint and region, the release tag (or the GitHub release page), and a second terminal.
4. **Production budgets.** Production uses about 375 of the 400 requests an hour that Rijkswaterstaat allows on `ddapi20-waterwebservices.rijkswaterstaat.nl` (`docs/plan/ARCHITECTURE.md` §7.3). Whether RWS counts that limit **per API key or per IP is not known** ([U], KG to be recorded by the owner): until it is, the drill must not capture NL-1 at all (and CH-1 is skipped because LINDAS wants one request per 10 minutes, never faster). That is what `RWS_CAPTURE_SKIP` is for (§4).

## 1. Verify the release and run bootstrap

On the new VPS, as root, in an interactive shell:

```bash
# bootstrap.md §1: download cosign (sha256-pinned), the manifest, its Sigstore bundle and the deploy bundle,
# verify the manifest against the release workflow's identity, and unpack only a verified bundle.
# The identity and the issuer are the ones in deploy/bin/rws-lib.sh (RWS_IDENTITY, RWS_ISSUER):
#   --certificate-identity https://github.com/mwijkhuisen/Waterheight/.github/workflows/release.yml@refs/heads/main
#   --certificate-oidc-issuer https://token.actions.githubusercontent.com
cd /root/rws-release
bundle/deploy/host/bootstrap.sh --dry-run
bundle/deploy/host/bootstrap.sh
bundle/deploy/host/bootstrap.sh
```

Do the whole fetch-and-verify block of `docs/runbooks/bootstrap.md` §1 first; it ends with the line below. Then bootstrap twice.

```text
Verified OK
deploy-bundle.tar.gz: OK
VERIFIED: release prod-YYYYMMDDTHHMMSSZ in /root/rws-release/bundle
…
0 change(s)
```

**Check:** the last line of the verify block is `VERIFIED: release prod-…` (note the tag); the second bootstrap says `0 change(s)`; in a second terminal log in as `ops` before you close the first. `sudo systemctl is-active rws-firewall docker chrony` prints three `active`.

## 2. Secrets (A7) and bootstrap again

`bootstrap.md` §3 has the table. With `sudoedit /etc/rws/secrets/<name>`:
- `restic_password`: the repository password;
- `s3_credentials`: `[default]`, `aws_access_key_id = …`, `aws_secret_access_key = …`. **Drill: the read-only key.** Real rebuild: the VPS key of `deploy/host/s3-vps-key-policy.json`;
- `rws_x_api_key` and the six `db_*` files are generated by bootstrap. (A new VPS has a new `rws_x_api_key`; on a real rebuild put the old value back from the password manager so that RWS still knows it, C7.);
- `hc_ping_key`: the healthchecks ping key on a real rebuild. **Drill: leave the file empty**, so no check on healthchecks.io ever hears from the drill, and do not create `hc_api_key`.

Then run bootstrap again: it resets every secret to `root:<gid> 0440`.

```bash
sudo /usr/local/lib/rws/deploy/host/bootstrap.sh
sudo stat -c '%n %a %U:%G' /etc/rws/secrets/*
```

```text
… 0 change(s)
/etc/rws/secrets/db_postgres 440 root:rws-dbpostgres
…                                       (every file 440 root:rws-…)
```

**Check:** every file is `440 root:rws-*`. **Drill:** `sudo test ! -s /etc/rws/secrets/hc_ping_key && echo empty` prints `empty`.

## 3. Quiet the host

`bootstrap.sh` enables `rws-update.timer`, `rws-backup.timer` and `rws-restore-drill.timer` (and starts WireGuard) on every run. A running `rws-update` would deploy by itself within 5 minutes of a complete `rws.env`; a backup of the half-empty archive would become the newest snapshot (`restore.md` §1). So switch them off after the last bootstrap run:

```bash
sudo systemctl disable --now rws-update.timer rws-backup.timer rws-restore-drill.timer
# Drill only: no WireGuard, so nothing answers on 10.66.0.1 or on UDP 51820.
sudo systemctl disable --now wg-quick@wg0.service
systemctl is-enabled rws-update.timer rws-backup.timer rws-restore-drill.timer
```

```text
disabled
disabled
disabled
```

**Check:** three `disabled`. Do not run `bootstrap.sh` again before the end of §9: it would turn them on. (On a real rebuild, §9 enables the three timers again; WireGuard stays up for §11.)

## 4. `rws.env`

`sudoedit /etc/rws/rws.env` (plain `KEY=VALUE`, `bootstrap.md` §4):

| Key | Real rebuild | Drill |
|---|---|---|
| `RWS_DOMAIN` | the production domain | the drill hostname |
| `RWS_CONTACT_EMAIL`, `RWS_OPERATOR_NAME`, `RWS_CDN_NAME` | as production | as production |
| `RWS_RESTIC_REPOSITORY`, `RWS_S3_REGION` | as production | as production (the bucket is the source of the restore) |
| `RWS_BACKUP` | `on` (the restore commands need it; the backup timer stays off until §9) | `on` (restore only: the key cannot write) |
| `RWS_CAPTURE_SKIP` | not set | `CH-1,NL-1` |
| `RWS_SITE_PHASE` | not set (follows the compose default: the phase the release serves) | `prelaunch` (pinned: the drill is never indexed, even after the launch flip) |
| `RWS_OWNER_SITE` | `on` in §11 | not set |
| `RWS_TRUSTED_PROXIES` | as production: the proxy in front of the site (KG-228, `api.md` §6); then `sudo rws-trusted-proxies` exempts it from the connection cap at once (else `rws-tick` within 10 minutes) | not set, unless a proxy fronts the drill host |

`RWS_SITE_PHASE` is read by the web container only (the phase files of the web image); on the production VPS it stays unset, so the reviewed compose default decides. `RWS_CAPTURE_SKIP` is a comma-separated list of catalogue source IDs. The capture role leaves out the specs of those sources and only those: it can never add a target, and an unknown or malformed ID stops capture at start with exit 78 and a fixed code (`RWS_CAPTURE_SKIP_MALFORMED`, `RWS_CAPTURE_SKIP_UNKNOWN`). It is never set in production.

```bash
sudo grep -c '^RWS_CAPTURE_SKIP=CH-1,NL-1$' /etc/rws/rws.env    # drill: 1; real rebuild: 0
sudo grep -c '^RWS_SITE_PHASE=prelaunch$' /etc/rws/rws.env       # drill: 1; real rebuild: 0
sudo rws-update --dry-run
```

```text
1
1
```

**Check:** the two greps print what the column says (on the drill `1` and `1`; on a real rebuild `0` and `0`); `rws-update --dry-run` no longer says "rws.env is not complete". The drill pin is what keeps `rebuild-check.sh` `noindex` PASS after the launch flip, when the compose default is `launch`.

## 5. DNS (real rebuild), then deploy the verified release

**Real rebuild: cut DNS over first.** `rws-deploy`'s smoke test needs `/healthz` over a valid certificate for the production name (it only pins the connection to `RWS_PUBLIC_IPV4`; it does not skip TLS), and the new VPS has no ACME state (it is not in the backup, KG-055; KG-323). Caddy can only get that certificate once the name points at the new VPS. So, before `rws-deploy`, with the TTL lowered (Before the clock starts, step 2), change the `A` and `AAAA` records of the production domain to the new VPS's addresses (`RWS_PUBLIC_IPV4`, `RWS_PUBLIC_IPV6` in `rws.env`). The site then shows the empty, restoring stack until §9: for a real disaster the old VPS is gone anyway; a planned move that must keep the old VPS serving is rehearsed as the drill instead. Until the certificate is in (about a minute after the first start), judge the new stack without TLS: `sudo docker compose -p rws ps` and `docker exec` into the containers (§7), never `curl -k` or a check that needs a valid certificate. There is no `owner.<domain>` record, ever (`owner-device.md`).

```bash
dig +short A <domain>; dig +short AAAA <domain>     # the new VPS's addresses, from two public resolvers
```

**Drill:** nothing to do; the drill hostname's records exist from "Before the clock starts" and the production records are not touched.

`rws-deploy` verifies the manifest and all three images against the release workflow's identity `https://github.com/mwijkhuisen/Waterheight/.github/workflows/release.yml@refs/heads/main` with the issuer `https://token.actions.githubusercontent.com` before it pulls by digest, creates the empty database, runs the migrations and the registry sync, and starts the stack (`deploy-rollback.md`). Use the tag that §1 verified:

```bash
tag=$(sudo grep -o '"tag": *"prod-[0-9]\{8\}T[0-9]\{6\}Z"' /root/rws-release/release-manifest.json | grep -o 'prod-[0-9]\{8\}T[0-9]\{6\}Z')
sudo rws-deploy "$tag"
# stop what would write into the directory and the database you restore (restore.md §1):
sudo docker compose -p rws stop capture load
```

To check one image by hand, the same test `rws-deploy` applies: `sudo rws-deploy --verify-image ghcr.io/mwijkhuisen/waterheight/server@sha256:<digest from images.env>` prints `verified: …`.

```text
… smoke test passed
```

**Check:** `sudo docker compose -p rws ps` shows caddy, db, api and watchdog healthy and `capture` and `load` stopped; `sudo cat /var/lib/rws/current` is the tag. A failed deploy names its code (`deploy-rollback.md`): fix the cause, run it again. **Drill:** Caddy gets a certificate for the drill hostname within a minute.

**Start the basemap now** in a second terminal (§10): it needs no database and takes hours.

## 6. Restore the snapshot (raw and dump)

Pick the newest snapshot taken **before the loss** and restore it by its ID, never `latest` (`restore.md` §2). The drill key cannot write, so every restic call takes `--no-lock` (a read command that must not create its lock file):

```bash
sudo bash -c '. /usr/local/lib/rws/deploy/bin/rws-lib.sh; backup_ready; allow_bucket "$BUCKET_HOST";
  rws_compose run --rm --no-deps -T backup snapshots --host rws --no-lock'
id=<the snapshot ID you picked>
sudo bash -c '. /usr/local/lib/rws/deploy/bin/rws-lib.sh; backup_ready; allow_bucket "$BUCKET_HOST";
  rws_compose run --rm --no-deps -T backup restore "$1" --target /restore --no-lock' _ "$id"
sudo cp -a /srv/rws/backup/drill/data/raw/. /srv/rws/raw/
sudo chown -R 65532:65532 /srv/rws/raw && sudo find /srv/rws/raw -type d -exec chmod 0750 {} + && sudo find /srv/rws/raw -type f -exec chmod 0640 {} +
sudo ls -l /srv/rws/backup/drill/data/db
```

On a real rebuild with a writable key the `--no-lock` flag is optional. Note the snapshot `time` (it is the start of the D19 window) and the age of `rws.dump`.

```text
… (the snapshot list: id, time, host rws)
-r--r----- 1 … rws.dump
-r--r----- 1 … globals.sql
```

**Check:** the snapshot's time is the one you meant (RPO ≤ 1 h); `rws.dump` and `globals.sql` are listed (the dump is at most 24 h older than the snapshot); `sudo find /srv/rws/raw/_manifest -name '*.jsonl' | wc -l` is the number of manifest days you expect. Keep `/srv/rws/backup/drill` until §8 is done.

## 7. Restore the database (route B)

The dump holds the tables, the grants and the loader's cursor. Restore it into an empty database, then deploy the same release again so that passwords, settings and any newer migration are applied (`restore.md` §3):

```bash
sudo docker compose -p rws stop load api
sudo docker exec -i rws-db-1 psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE rws WITH (FORCE)' \
  -c "CREATE DATABASE rws TEMPLATE template0 OWNER rws_owner LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' ENCODING 'UTF8'"
sudo cat /srv/rws/backup/drill/data/db/rws.dump | sudo docker exec -i rws-db-1 pg_restore -U postgres -d rws --exit-on-error
sudo rws-deploy "$(sudo cat /var/lib/rws/current)"
sudo docker compose -p rws stop capture load
```

The last command stops `capture` and `load` again (the deploy started them): they start in §9, once the raw archive is complete. Route A (replay from the archive) is the alternative only while the archive holds every observation object and no unit or factor change is recorded (`restore.md` §3).

```text
… (pg_restore prints nothing on success)
```

**Check:** `sudo docker exec rws-db-1 psql -X -U postgres -d rws -Atc "select count(*) from series"` prints a number above 0; the deploy ended with its smoke test; `curl -s https://<domain>/api/v1/health` answers JSON (the DNS and certificate of §5 are in place on a real rebuild and on the drill).

## 8. Replay since the dump

Start `load`: its cursor is the dump's, so it reads every manifest line after the dump from the restored archive and loads it, in order (`restore.md` §3; the rules are in `replay.md`):

```bash
sudo docker compose -p rws start load
curl -s https://<domain>/api/v1/health | jq '.loader'
```

Repeat the second command until `backlog_bytes` is 0. Anything still skipped or quarantined is replayed by hand: `replay.md` §2 (`rwsc run --rm --no-deps -T load replay --source <ID> --from <day> --to <day>`; first with `--dry-run`).

```text
{ … "backlog_bytes": 0, … }
```

**Check:** `backlog_bytes` is 0 and `docs/runbooks/schema-drift.md` has nothing to say about quarantined payloads. A second replay of a day changes nothing (`"n_new":0,"n_changed":0`).

## 9. Start capture, load and api; the D19 window

```bash
sudo docker compose -p rws start capture load api
sudo find /srv/rws/backup/drill -mindepth 1 -delete       # the restore may hold owner-audience rows: always empty it
# Real rebuild only:
sudo systemctl enable --now rws-update.timer rws-backup.timer rws-restore-drill.timer
sudo rws-restore-drill --force                            # every sampled object matches its manifest sha256
curl -s https://<domain>/status/capture.json | jq -r '.generated_at'
```

`rws-restore-drill` restores into a throw-away database on the same disk as the raw archive: it watches the disk and aborts when use passes 90 % (`disk-full.md`), and records the drill as done only after both of its parts have run. Capture's start-up recovery records any object without a manifest line, and each spec's gap-stretch window then refetches what the provider still keeps (5 to 40 days). The D19 window is the snapshot time from §6 to the first successful capture after this step; write both instants in the daily report. **Drill:** leave the three timers disabled and do not run `rws-restore-drill`.

```text
… every sampled object matched    (real rebuild; the output of rws-restore-drill)
2026-…T…Z                       (capture.json generated_at: a minute old)
```

**Check:** `capture.json` is fresh; `sudo docker compose -p rws ps` shows capture, load and api healthy. **Drill:** `curl -s https://<drill hostname>/status/capture.json | jq -r '.specs[].spec' | grep -cE '^(ch-1|nl-1)-'` prints `0`.

## 10. The basemap and the river files

Neither is in the backup. Both are signed downloads that take no database, so start them as soon as §5 is done, in a second terminal (an SSH drop stops the run):

```bash
sudo rws-basemap-refresh --dry-run
sudo rws-basemap-refresh 2>&1 | tee ~/basemap-rebuild.log       # the newest eligible build; basemap.md §3: hours
sudo rws-rivers-refresh --dry-run
sudo rws-rivers-refresh                                                                          # geo-refresh.md "Serving the rivers"
```

```text
… basemap refresh done (the role's lines above say whether a build was promoted)
```

**Check:** `jq -c . /srv/rws/tiles/manifest.json` names a current build (basemap and world file); `scripts/verify-prod.sh` (§13) passes `rivers manifest`, `rivers tiles`, `rivers reaches` and `rivers download`. The extract runs for hours, takes its own lock and does not hold the deploy lock: the data and the API are correct without it, the map is not. Its wall-clock time counts in the total, so measure it.

## 11. WireGuard and the owner site (real rebuild; owner)

The new VPS has a **new** WireGuard server key and a new internal CA (`owner-device.md`). Nothing of this exists on the drill: no peer, no owner port, `RWS_OWNER_SITE` unset.

```bash
# on the VPS
sudo /usr/local/lib/rws/deploy/host/bootstrap.sh            # also starts wg-quick@wg0 (after §9 it is safe to run again)
sudoedit /etc/rws/secrets/owner_basic_auth                  # owner-password-rotation.md: a new bcrypt hash
sudo sed -i 's/^RWS_OWNER_SITE=.*/RWS_OWNER_SITE=on/' /etc/rws/rws.env   # or add the line
sudo rws-deploy "$(sudo cat /var/lib/rws/current)"
sudo rws-wg-peer add laptop > laptop.conf                   # owner-device.md, once per device, from the device
# on each device, with the tunnel up
scripts/verify-owner.sh <domain> --cacert owner-root.crt
```

Every device config holds the old server public key: revoke and re-add each device, and export the new Caddy root CA (`owner-device.md`). Only your own devices; no other peer.

```text
… (one PASS line per check, no FAIL)
```

**Check:** `sudo wg show wg0` lists only your own devices; `scripts/verify-owner.sh` has no FAIL; `verify-prod.sh` `owner listener` passes (§13).

## 12. DNS check and TTL restore

**Real rebuild.** The cut-over itself was the first thing of §5. Here you verify it and put the TTL back (300 s was for the move; use the value you had). The `A` and `AAAA` records must answer the new VPS's addresses from at least two public resolvers, and the certificate must be valid (no `-k`).

```bash
dig @1.1.1.1 +short A <domain>; dig @9.9.9.9 +short AAAA <domain>
curl -sI https://<domain>/healthz | head -1
```

**Drill.** The drill hostname's own records were created in "Before the clock starts"; the production records are not touched, and there is nothing to put back.

```text
203.0.113.7                      (the new VPS's IPv4)
2001:db8::7                      (and IPv6)
HTTP/2 200
```

**Check:** both lookups return the new addresses from both resolvers; `/healthz` is a 200 over a valid certificate.

## 13. verify-prod

From a checkout with `pnpm install --frozen-lockfile` on your workstation, no SSH. The profile is the phase the deployed release serves: `prelaunch` until the launch flip (E4), `launch` after it. The drill is always `prelaunch`.

```bash
scripts/verify-prod.sh <domain> --profile prelaunch      # or --profile launch after E4 (real rebuild)
```

```text
PASS … (every line PASS)
```

**Expected FAILs on the drill (skipped sources, not judged).** The drill does not capture NL-1 and CH-1 (`RWS_CAPTURE_SKIP`), so their data stops at the snapshot and the checks that need it fresh fail by design: `health NL-1`, `tier-1 NL-1`, `fresh NL-1`, `forecast NL-1`, `belgian set` (its NL-1 locations), and `health CH-1`, `tier-1 CH-1`, `coverage CH-1`, `fresh CH-1`, `interval CH-1` (no download of `ch-1-lindas` yet: a FAIL), `forecast CH-4` (its series are the CH-1 stations'). Write them in the sheet as "expected: skipped"; any other FAIL is judged as below. `replay NL-1` and the DE-1, FR-1, DE-7 and LU-1 lines must pass. **Other providers see a second IP.** The drill captures every other source from a second address, and its gap-stretch refetch (§9) is a burst of back-fill requests on top of production's schedule. Each provider's polite limits are the same code as production's, but run the drill once, keep it short, delete the VPS afterwards (below) and do not repeat it in quick succession.

**Check:** no FAIL other than those. Lines that need data the rebuild has not collected yet (the 72 h soak, `--soak`) are not part of this run. The fresh-data lines (`tier-1`, `freshness`, `loader lag`) need the loader caught up (§8). Judge any other FAIL against `docs/known-gaps.md` and `docs/risk-register.md` before you call the step passed.

## 14. The Q7 gap check

A rebuild is only done when it has left no hole in a source the providers can refill. The Q7 coverage of `/api/v1/health/sources` lists the newest gaps between loaded payloads of each source's tier-1 series. **Pass:** zero gaps for each source whose provider window is 7 days or more and that the run captures (the list and how it is derived: `docs/drills/rebuild-timing-sheet.md`: DE-1, DE-7, FR-1 and LU-1). Wait for the loader to catch up and the first gap-stretch refetch to finish (§9); then:

```bash
curl -s https://<domain>/api/v1/health/sources |
  jq -r '.sources[] | select(.id=="DE-1" or .id=="DE-7" or .id=="FR-1" or .id=="LU-1") | "\(.id) gaps=\(.coverage.gaps | length) ratio=\(.coverage.ratio)"'
# Drill: all guard rails of this page in one table, then the same Q7 check:
sudo /usr/local/lib/rws/deploy/tests/rebuild-check.sh <drill hostname> --production <production domain>
```

```text
DE-1 gaps=0 ratio=1
DE-7 gaps=0 ratio=1
FR-1 gaps=0 ratio=1
LU-1 gaps=0 ratio=1
…
rebuild-check: all rows PASS or SKIP (read the SKIP reasons)
```

**Check:** four `gaps=0` lines. On the drill, `rebuild-check.sh` also asserts the drill's guard rails: the hostname is the drill's, `X-Robots-Tag: noindex`, the three timers disabled, no healthchecks secret, nothing listening on `10.66.0.1:443` or UDP 51820, the bucket key refused a restic write, and `RWS_CAPTURE_SKIP` covers CH-1 and NL-1 (also in the running capture). CH-1 and NL-1 are skipped on the drill and are **not judged**. A gap in a judged source is a FAIL: the hole is the interval it names. Replay it (`replay.md`) or accept it and say so in the sheet; either way the drill does not pass.

Paste the table into the sheet's check column. Then stop the clock.

## After the drill

- Delete the drill VPS (it holds a copy of the owner-audience payloads and the database; `restore.md`), its DNS records and the read-only key. Do not restore a drill to production.
- Fill in the sheet's total, the Q7 result and the D19 window, and tick E3 in #27 with the sheet.
- Anything that took longer than you expected, or a step this page got wrong, goes into `docs/known-gaps.md` as a KG with the step number.
