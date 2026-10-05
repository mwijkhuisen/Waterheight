# Runbook: bootstrap the VPS and go live

From an empty Debian 13 VPS to a recorder that is deployed, backed up and watched (issue #16 P1b; A§11). Every step has a check command. The owner does the steps marked **owner**; nothing here needs an agent. Commands with `sudo` run on the VPS as `ops`.

The order that gets capture live fastest:

1. owner steps A2–A6 and B2 (below);
2. merge the P1b PR;
3. approve `promote`;
4. B4;
5. fetch and verify the release;
6. `bootstrap.sh`;
7. the secrets, then `rws.env` (a complete `rws.env` starts the deploys);
8. the first deploy;
9. backups;
10. `rws-hc-sync`;
11. `verify-prod.sh`.

## 0. Owner prerequisites (PHASES §6.2)

| Step | What | Check |
|---|---|---|
| **A2** | The domain, plus the `contact@` and `security@` mailboxes | `dig +short MX <domain>`; send a test mail to `contact@<domain>` |
| **A3** | The VPS: EU, 4 vCPU, 8 GB, ≥ 200 GB NVMe, IPv4 + IPv6, **Debian 13 amd64**. Provider snapshots weekly, provider firewall 22 from your IPs if static, console access tested, your SSH key installed (FIDO2 `sk-ed25519` recommended) | `ssh root@<ip> 'grep VERSION_CODENAME /etc/os-release; dpkg --print-architecture; nproc; free -g; df -h /; ip -br a'` shows trixie, amd64, 4, ~8, ≥ 200G and a global IPv4 and IPv6 |
| **A4** | DNS: `A` and `AAAA` → the VPS; `CAA 0 issue "letsencrypt.org"`; DNSSEC if offered | `dig +short A <domain>`; `dig +short AAAA <domain>`; `dig +short CAA <domain>` |
| **A5** | The EU S3 bucket, created **with Object Lock** (COMPLIANCE, 30 days), versioning on, reachable on port 443. Two keys: the **VPS key** with `deploy/host/s3-vps-key-policy.json` (replace `RWS_BUCKET`), and a **workstation key** for `restic forget --prune`. The restic repository password is generated and kept offline (password manager + paper) | The provider console shows versioning and the default retention. After step 6: `sudo /usr/local/lib/rws/deploy/tests/object-lock-prune.sh` prints five PASS lines |
| **A6** | healthchecks.io: an account, a project with e-mail and phone/push integrations, and the project's **ping key** and an **API key** (read-write) | Step 7 creates the 18 checks from P9a; the project page lists them |
| **A7** | The secrets on the VPS (step 3): four you fill, and from P2a six database passwords that `bootstrap.sh` generates | `sudo ls -l /etc/rws/secrets` |
| **B2** | GitHub environment `production`: required reviewer = you, deployment branch = `main`, **no secrets** | `scripts/gh-settings.sh --check` (from a checkout) |
| **B4** | After the first release: set the three GHCR packages `waterheight/server`, `web` and `backup` to **public** (Package settings → Change visibility) | `curl -s 'https://ghcr.io/token?scope=repository:mwijkhuisen/waterheight/server:pull' \| grep -q '"token"' && echo public` |

The VPS key may put, get, list and **delete objects**: restic deletes its own lock files, and under versioning a delete only adds a delete marker. It may **not** delete object versions, bypass or change retention, change the lock or versioning configuration, or add lifecycle rules (`s3-vps-key-policy.json`). Pruning (7 daily, 8 weekly, 12 monthly) runs only from the workstation, with the workstation key.

## 1. Fetch and verify the release (never a git checkout)

Nothing on the VPS runs unless it came out of a release that `cosign` verified against the release workflow's identity. On the first run cosign itself is pinned by sha256; it is the same pin as in `bootstrap.sh`.

Run it as **root** (`ssh root@<ip>`, or `sudo -i` from the image's default user), in an interactive shell. The block never exits your shell: every check that fails sets `ok=no`, and only a fully verified release is unpacked. `deploy/tests/runbook.test.sh` runs its `sha=` and `tag=` lines against `release.yml`'s own manifest.

```bash
work=/root/rws-release; rm -rf "$work"; mkdir -p "$work" && cd "$work" && ok=yes || ok=no
curl --proto '=https' -fsSLo cosign https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-amd64
echo "4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71  cosign" | sha256sum -c - && chmod +x cosign || ok=no
base=https://github.com/mwijkhuisen/Waterheight/releases/latest/download
for f in release-manifest.json release-manifest.sigstore.json deploy-bundle.tar.gz; do
  curl --proto '=https' -fsSLO "$base/$f" || ok=no
done
./cosign verify-blob --bundle release-manifest.sigstore.json \
  --certificate-identity https://github.com/mwijkhuisen/Waterheight/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com release-manifest.json || ok=no
sha=$(grep -o '"sha256": *"[0-9a-f]\{64\}"' release-manifest.json | grep -o '[0-9a-f]\{64\}')
tag=$(grep -o '"tag": *"prod-[0-9]\{8\}T[0-9]\{6\}Z"' release-manifest.json | grep -o 'prod-[0-9]\{8\}T[0-9]\{6\}Z')
echo "$sha  deploy-bundle.tar.gz" | sha256sum -c - || ok=no
if [ "$ok" = yes ] && [ "${#sha}" -eq 64 ] && [ -n "$tag" ] && mkdir bundle && tar -xzf deploy-bundle.tar.gz -C bundle; then echo "VERIFIED: release $tag in $work/bundle"; else echo "STOP: not verified; run nothing from $work"; fi
```

**Check:** `Verified OK`, `deploy-bundle.tar.gz: OK`, and the last line says `VERIFIED: release prod-…`. On `STOP`, run nothing and find out why (a download, the signature or the bundle hash).

## 2. Run bootstrap

From `/root/rws-release`, as root:

```bash
bundle/deploy/host/bootstrap.sh --dry-run   # what it would change
bundle/deploy/host/bootstrap.sh             # do it
bundle/deploy/host/bootstrap.sh             # again: must report "0 change(s)"
```

What it does:

- **Access:**
  - it creates `ops` with NOPASSWD sudo. If `ops` has no key, it copies the `authorized_keys` of the user who ran `sudo` (else root's), without any `command="…"` key (cloud images use one to say "log in as …"); it stops rather than lock you out;
  - SSH becomes keys-only, `PermitRootLogin no`, `AllowUsers ops`.
- **System:**
  - UTC, chrony, AppArmor required;
  - unattended-upgrades with a reboot at 03:40 UTC when needed, needrestart, and the sysctl baseline.
- **Firewall:** `rws-firewall.service`, which replaces the masked `nftables.service`.
- **Docker:** Docker 29.8.1, Compose 5.5.1 and containerd 2.3.5, pinned and held; cosign 3.1.3.
- **Files:** `/srv/rws` and `/etc/rws/secrets` with the contract owners and modes; from P2a also `/srv/rws/backup/db` (`root:61003` 0750, the nightly dump; its parent `/srv/rws/backup` is `root:root` 0700 since review round 1: the backup job mounts only the subdirectories) and `/etc/rws/postgres/{pg_hba,pg_ident}.conf` (world-readable, no secret in them; a running `db` re-reads them on SIGHUP).
- **Settings:**
  - a generated `rws_x_api_key`, and a template `/etc/rws/rws.env`;
  - from P2a, the six database passwords (`db_*`, step 3), generated once and never overwritten;
  - the host scripts in `/usr/local/lib/rws/deploy`, with symlinks in `/usr/local/bin`;
  - the timers.

**Check:**

- log in again **in a second terminal** as `ops` before closing the first;
- `sudo systemctl is-active rws-firewall docker chrony`;
- `sudo nft list table inet rws | head`;
- `sudo docker version --format '{{.Server.Version}}'` (29.8.1);
- `systemctl list-timers 'rws-*'`.

## 3. Put the secrets in place (A7)

The secrets come **before** `rws.env` is complete: from then on `rws-update.timer` deploys within 5 minutes. (Capture and the watchdog read the ping key before every ping, so a key filled in later still takes effect.)

Use `sudoedit /etc/rws/secrets/<name>` for each file you fill (the ones the table does not mark as generated), then **run `bootstrap.sh` again** (`sudo /usr/local/lib/rws/deploy/host/bootstrap.sh`): it resets every secret to `root:<gid> 0440`.

| File | Content | Read by |
|---|---|---|
| `hc_ping_key` | the healthchecks.io project **ping key** | capture, watchdog (gid 61001); the host timers as root |
| `rws_x_api_key` | generated by bootstrap. Keep it; C7 tells RWS the value | capture (gid 61002) |
| `restic_password` | the repository password from A5 | backup (gid 61003) |
| `s3_credentials` | `[default]`, then `aws_access_key_id = …`, then `aws_secret_access_key = …` (the **VPS key**) | backup (gid 61003) |
| `ghcr_token` | only if the repository were private (it is public, D7) | – |
| `db_postgres` | P2a. **Generated by bootstrap**: 32 CSPRNG bytes as 64 lowercase hex characters. Read by the `db` container's first-run set-up only: the superuser never logs in over TCP | db (gid 61004) |
| `db_rws_migrator` | P2a, generated | migrate job (gid 61005) |
| `db_rws_load` | P2a, generated | load (gid 61006) |
| `db_rws_publish` | P2a, generated | nothing before P9 (gid 61007) |
| `db_rws_api` | P2a, generated | api (gid 61008) |
| `db_rws_owner_api` | P2a, generated | nothing before P9 (gid 61009) |

Never fill a `db_*` file by hand. `bootstrap.sh` writes a value into a `db_*` file **only while it is empty**, in place (so the file keeps `root:<gid> 0440`), never overwrites one and never prints it. A `db_*` file that holds anything but 64 lowercase hex characters stops bootstrap and `rws-deploy` (`db_prepare_failed`): empty it (`: > file`) and run bootstrap again. `rws-deploy` sets each password on its role through `psql` on the `db` container's local socket, from stdin (never argv or the environment), before the migrations run.

Compose mounts a file secret with its **host** owner and mode (it ignores `uid`, `gid` and `mode` for file secrets). A root-owned 0600 file would be unreadable to the uid-65532 containers. So each file is readable by its own group only, and only the consuming container has that group (`group_add` in `deploy/compose.yaml`) and mounts it. The directory itself is `root 0700`.

**Check:** `sudo stat -c '%n %a %U:%G' /etc/rws/secrets/*` shows every file `440 root:rws-*`.

**Changing a secret later** (a new ping key, a rotated S3 key): edit it in place with `sudoedit`, never by replacing the file (`mv`, `install`, or an editor that renames). Compose bind-mounts each file secret by its inode, so a running container keeps reading a replaced file's old content. An in-place edit of `hc_ping_key` takes effect at the next ping; `rws_x_api_key` is read when capture starts, so run `sudo docker restart rws-capture-1` after changing it. If a file was replaced, `sudo docker restart rws-capture-1 rws-watchdog-1` mounts the new one. The backup job reads `restic_password` and `s3_credentials` in a fresh container on every run. Redeploying the current release (`rws-deploy`) does not help here: `up -d` recreates a container only when its configuration changes.

**Rotating a database password** works the other way round: the value lives in the database too, so `rws-deploy` is what sets it. For the role `rws_api` (secret `db_rws_api`, consumer `rws-api-1`; `rws_load` and `db_rws_load` for `rws-load-1`):

```bash
sudo sh -c ': > /etc/rws/secrets/db_rws_api'     # empty it in place: the file keeps its owner, mode and inode
sudo /var/lib/rws/releases/<the release you bootstrapped last>/deploy/host/bootstrap.sh    # generates a new value in the same file
sudo rws-deploy "$(sudo cat /var/lib/rws/current)"  # db_prepare sets the new password on the role
sudo docker restart rws-api-1                       # the consumer reads its secret at start
```

`db_rws_migrator` is read by the migrate job on every deploy: nothing to restart. `db_postgres` is used only when the cluster is first created, so rotating it changes nothing: leave it. `db_rws_publish` is read by `publish` and `db_rws_owner_api` by `publish-owner` (P9a; and `api-owner` from P9b): restart them after a rotation (`sudo docker restart rws-publish-1 rws-publish-owner-1`). Check that the consumer is healthy again: `sudo docker compose -p rws ps`.

## 4. Fill `/etc/rws/rws.env`

`sudoedit /etc/rws/rws.env`. These are plain `KEY=VALUE` lines, without quotes:

| Key | Value |
|---|---|
| `RWS_DOMAIN` | the domain of A2/A4, e.g. `rivierstanden.nl` |
| `RWS_CONTACT_EMAIL` | `contact@<domain>` (in every provider request's User-Agent) |
| `RWS_PUBLIC_IPV4`, `RWS_PUBLIC_IPV6` | detected by bootstrap. Check them against A4's DNS records: the site is published **only** on these addresses |
| `RWS_RESTIC_REPOSITORY` | `s3:https://<endpoint>/<bucket>/restic` (port 443 only: the firewall allows no other) |
| `RWS_S3_REGION` | the provider's region (e.g. `fr-par`, `eu-central-1`) |
| `RWS_BACKUP` | leave `off` until step 6 |

**Check:** `sudo rws-update --dry-run` no longer says "rws.env is not complete".

## 5. The first deploy

Either wait up to 5 minutes for `rws-update.timer`, or run it now, as `ops`, with the tag that step 1 verified:

```bash
tag=$(sudo grep -o '"tag": *"prod-[0-9]\{8\}T[0-9]\{6\}Z"' /root/rws-release/release-manifest.json | grep -o 'prod-[0-9]\{8\}T[0-9]\{6\}Z')
sudo rws-deploy "$tag"
```

It verifies the manifest and all three images, pulls by digest, and, for a release with a `db` service (P2a on), starts `db`, sets the roles and passwords and runs the `migrate` job (`docs/runbooks/deploy-rollback.md`). Then it runs `up -d` and smoke-tests: `/healthz` 200 over real TLS, a fresh `capture.json` and, when the release has an `api`, `/api/v1/health` with a JSON status. Caddy gets its Let's Encrypt certificate in the first minute, so A4 must be in place. If the first deploy fails, it says why and leaves the containers running. Fix the cause (DNS, B4, `rws.env`), then run `rws-deploy <tag>` again.

**Check:**

- `sudo docker compose -p rws ps`: caddy, capture and watchdog show `healthy`, and from P2a db, load and api too;
- `curl -s https://<domain>/status/capture.json | head -c 300`;
- `sudo cat /var/lib/rws/current`.

## 6. Backups (A5)

```bash
sudo sed -i 's/^RWS_BACKUP=off$/RWS_BACKUP=on/' /etc/rws/rws.env
sudo rws-backup --init                 # once: creates the restic repository
sudo rws-backup                        # the first backup (the timer runs hourly at :17)
sudo rws-restore-drill --force         # 100 random objects restored and checked
sudo /usr/local/lib/rws/deploy/tests/object-lock-prune.sh   # the VPS key cannot remove versions
```

**Check:**

- `curl -s https://<domain>/status/ops.json` shows `last_backup` and `"drill":{"…","sampled":100,"matched":100}`;
- `object-lock-prune.sh` prints five PASS lines.

## 7. Healthchecks (A6), from your workstation

```bash
deploy/bin/rws-hc-sync --dry-run                        # the 18 checks it will create
deploy/bin/rws-hc-sync --key-file ~/secure/hc_api_key   # create or update them
```

Keep the API key off the VPS: it can delete the checks that watch the VPS. If you run it on the VPS instead, delete `/etc/rws/secrets/hc_api_key` afterwards.

**Check:** the project lists 18 checks. After 10 minutes, `cap-*`, `update`, `watchdog`, `cert` and `disk` are green, and `backup` turns green at the next :17. From P2a, `load` (the watchdog pings it from `/api/v1/health`) turns green within 5 minutes of a release that serves the endpoint; until then it is not pinged. From P9a, `publisher` (the watchdog, from the age of `/data/v1/meta.json`) and `owner-publisher` (`rws-tick`, from the mtime of the owner `meta.json` only) turn green within 10 minutes of a release with the publishers; a 404 or a missing file is "not deployed" and sends nothing.

## 8. From outside

```bash
scripts/verify-prod.sh <domain>     # from a checkout with `pnpm install --frozen-lockfile`; no SSH
```

Every line must be PASS. IPv6 is N/A only if your own machine has no IPv6. Then run `docs/runbooks/owner-checks.md`.

## Later: a new release with changed host files

`rws-update` deploys new images and `compose.yaml` by itself, but it never replaces the host scripts, units, firewall or any other host file of `deploy/`. When the running release brings different ones, every `rws-update` run pings `update` `/fail` with `host_files_changed`, and its log says `release … brings changed host files: run …/bootstrap.sh`. Run that bootstrap (it sits inside the verified release directory); the next run is green again. Never run the bootstrap of a release older than the one you bootstrapped last, for instance after a rollback (`docs/runbooks/deploy-rollback.md`): it would downgrade the host files.

```bash
sudo /var/lib/rws/releases/<tag>/deploy/host/bootstrap.sh --dry-run
sudo /var/lib/rws/releases/<tag>/deploy/host/bootstrap.sh
```

## Later: the first release with the database (P2a; owner)

Do this on the VPS that already runs a P1b release. The installed P1b `rws-update` knows nothing about the database: given the P2a release it would deploy it without the database secrets, fail, roll back and put the tag into `skip_upto`. So the timer stops **before** the release is approved, and you deploy on purpose. The order matters:

1. **Stop the timer first**, before you approve `production` for the P2a release:

   ```bash
   sudo systemctl stop rws-update.timer
   ```

2. Merge the P2a PR and approve the `promote` job (environment `production`). Wait for the release `prod-<UTC>`.
3. Fetch, verify and unpack that release exactly as in step 1 above. Stop unless it prints `VERIFIED: release prod-…`; note the tag it prints.
4. Run the **new** bootstrap from that verified bundle, first as a dry run (as root, from `/root/rws-release`):

   ```bash
   bundle/deploy/host/bootstrap.sh --dry-run
   bundle/deploy/host/bootstrap.sh
   bundle/deploy/host/bootstrap.sh          # again: "0 change(s)"
   ```

   It generates the six `db_*` secrets (`root:<gid> 0440`, gids 61004–61009), creates `/srv/rws/backup/db` (`root:61003` 0750; it makes `/srv/rws/backup` itself `root:root` 0700) and `/etc/rws/postgres/{pg_hba,pg_ident}.conf`, installs the new host scripts (`rws-lib.sh` with the database steps, `rws-backup` with the nightly dump) and records the host files.

   **Check:** `sudo stat -c '%n %a %U:%G' /etc/rws/secrets/db_*` shows six files, each `440 root:rws-db…`; `ls -l /etc/rws/postgres`.

5. Deploy the verified tag on purpose (`sudo rws-deploy prod-…`, the tag from step 3). It runs the steps of `rws-lib.sh`: verify, pull by digest, `up --wait db` (the first start creates the cluster; allow a couple of minutes), set the roles and passwords, `run migrate` (dbmate, then the partitions, then the registry sync), `up -d`, smoke test. Its failure codes are in `docs/runbooks/deploy-rollback.md`.

   **Check:**

   ```bash
   sudo docker compose -p rws ps                                      # db, load, api healthy
   curl -s https://<domain>/api/v1/health | jq .                      # a JSON document; status may be down for the first minute
   ```

   `load` now replays everything since P1 by itself: its cursor starts at the first manifest day. Watch `loader.backlog_bytes` fall to 0 (`/api/v1/health`); while it is above 0, `verify-prod.sh` fails `replay DE-1`. During this first catch-up the oldest unconsumed line is older than 15 minutes, so the healthchecks `load` check fails with `load_backlog`, `verify-prod.sh` fails `loader lag` and `/api/v1/health` is `degraded`: expected, and it clears once the backlog is 0 (KG-069). If `loader.backlog_age_s` stops falling while `backlog_bytes` stays above 0, the loader is stalled: `docs/runbooks/schema-drift.md` §6.

6. Create the `load` check on healthchecks.io, from your workstation: `deploy/bin/rws-hc-sync --key-file ~/secure/hc_api_key` (18 checks from P9a; step 7 above).
7. Start the timer again:

   ```bash
   sudo systemctl start rws-update.timer
   ```

8. From outside: `scripts/verify-prod.sh <domain>`. Expect these to need your reading:
   - `tier-1 DE-1` can FAIL at low water: five tier-1 discharge series stop when the rating curve is cut off (on 2026-09-29: Köln, Düsseldorf, Wesel, Rees and Emmerich, 64 of 69 fresh = 92.8%). The line names the provider-stale count. You judge it (`docs/risk-register.md` R-041);
   - `replay DE-1` passes once the backlog is 0, DE-1 has partition checksums (they appear when the loader first catches up) and nothing is quarantined;
   - `health DE-1` and `loader lag` need fresh data from the running loader.

If the deploy fails, it rolls back to the P1b release (`db`, `load` and `api` are removed; the `pgdata` volume stays) and pings `update` `/fail` with `db_start_failed`, `db_prepare_failed` or `migrate_failed`. Fix the cause, then run step 5 again. A rollback leaves the `load` check without pings: it alerts after about 15 minutes until a release with the api runs again.

## Later: the release with P2b (NL-1, NL-2, NL-4; owner)

Do this on the VPS that already runs the P2a release. No new secret, service or healthchecks check and no `rws.env` change: the release brings one new host file, `rws-drill`, and the registry of the NL sources. There is no special order (the normal `rws-update` deploy works); these steps follow it.

1. Approve the `promote` job for the P2b release. `rws-update` deploys it within 5 minutes; the `migrate` job syncs the NL-1 registry, the Eijsden twin pair and the 702 NL-4 class bounds. **Check:**

   ```bash
   sudo docker compose -p rws ps                                        # db, load, api, capture healthy
   curl -s https://<domain>/api/v1/health/sources | jq '.twins'         # eijsden-grens-taw-nap, after the first hour
   ```

2. Until you run the release's bootstrap, `rws-update` pings `update` `/fail` with `host_files_changed` (the new `rws-drill`). Run it as in "a new release with changed host files" above, from the verified release directory, twice; the second run must say "0 change(s)". **Check:** `command -v rws-drill`.
3. Load the NL-1 payloads since P1: `docs/runbooks/replay.md` §5. The loader of the P2a release had no NL-1 adapter and moved its cursor past those lines, so this one replay is needed; NL-2 needs none (it stores nothing) and NL-4 is never replayed. `rwsc` is the shell function defined in `docs/runbooks/replay.md` §2; count first with `--dry-run`:

   ```bash
   rwsc run --rm --no-deps -T load replay --source NL-1 --from <first day> --to <today>
   ```

4. Set the two GitHub Actions **variables** `RWS_DOMAIN` and `RWS_CONTACT_EMAIL` (not secrets) for the nightly contract check (`docs/github-settings.md`), and start the workflow `contract-check` once by hand.
5. From outside: `scripts/verify-prod.sh <domain>`. The new lines are `health NL-1`, `tier-1 NL-1` (each series against its own `staleness_limit`: KG-081) and `replay NL-1`; `replay NL-1` passes once the backlog is 0 and nothing is quarantined.
6. The outage drill, the P2b `[owner]` criterion: `docs/runbooks/outage-drill.md`.
7. After 7 days: `scripts/verify-prod.sh <domain> --soak` for the Eijsden twin.

## Later: the release with the basemap job (P3; owner)

Do this on the VPS that already runs the P2b release. No new secret, `rws.env` setting, healthchecks check or migration, and no change to the release manifest or `rws-update`: the release brings a new job in `compose.yaml` (`basemap` and `basemap-promote`, profile `jobs`, from the same server image), Caddy's `/tiles` routes and a read-only mount of `/srv/rws/tiles`, and new host files (`rws-basemap-refresh`, `rws-basemap-refresh.service` and `.timer`, and a changed `rws-lib.sh`). There is no special order (the normal `rws-update` deploy works); these steps follow it.

1. Approve the `promote` job for the P3 release. `rws-update` deploys it within 5 minutes. **Check:** `sudo docker compose -p rws ps` (caddy, capture, watchdog, db, load and api healthy), `curl -s https://<domain>/healthz`. `scripts/verify-prod.sh <domain>` shows `tiles manifest`, `tiles previous` and `tiles 416` as FAIL until the first extract (step 3; without a manifest there is no file to ask for): expected.
2. Until you run the release's bootstrap, `rws-update` pings `update` `/fail` with `host_files_changed`. Run it as in "a new release with changed host files" above, from the verified release directory, twice; the second run must say "0 change(s)". It links `rws-basemap-refresh` into `/usr/local/bin`, installs the service and the timer (the timer is **not** enabled), changes the owner of `/srv/rws/tiles` to uid 65532 (it was root's; mode 0755) and creates `/srv/rws/tiles/.staging` (0700, uid 65532). Run it before the first refresh: without it Docker creates `.staging` as root and the fetch job cannot write there. **Check:**

   ```bash
   command -v rws-basemap-refresh
   stat -c '%n %a %U:%G' /srv/rws/tiles /srv/rws/tiles/.staging     # 755 65532:65532, then 700 65532:65532
   systemctl is-enabled rws-basemap-refresh.timer                   # disabled
   ```
3. Run the first refresh and enable the timer: `docs/runbooks/basemap.md` §3 to §7 (a dry run, an older build, then the newest, so that current and previous both exist; the `[owner]` criterion of P3 asks for its log and the sha256 comparison).
4. From outside: `scripts/verify-prod.sh <domain>`. The new lines are `tiles manifest`, `tiles <file>` (four after the second run), `tiles previous`, `tiles 404`, `tiles 416` and `map assets`.

## Later: the release with the river overlay (P6b; owner)

Do this on the VPS that already runs the P3 (or a later) release. No new secret, `rws.env` setting, healthchecks check or migration, and no new egress for any container: the release brings two read-only Caddy mounts in `compose.yaml` (`/srv/rws/public/data/v1/rivers` and `/srv/rws/public/downloads`), Caddy's `/tiles/rivers-<ver>.pmtiles`, `/data/v1/rivers/` and `/downloads/` routes, the registry sync of the rivers, reaches and station river fields in `migrate`, and new host files (`rws-rivers-refresh`, `rws-rivers-refresh.service` and `.timer`, a changed `bootstrap.sh`). There is no special order (the normal `rws-update` deploy works; Docker creates the two mounted directories as root 0755 if they do not exist yet); these steps follow it.

1. Approve the `promote` job for the P6b release. `rws-update` deploys it within 5 minutes; the `migrate` log line ends with `709 reaches, 0 rivernet stations unknown`. **Check:** `sudo docker compose -p rws ps` (caddy, capture, watchdog, db, load and api healthy). `scripts/verify-prod.sh <domain>` shows `rivers attribution` as PASS and `rivers manifest`, `rivers tiles`, `rivers reaches` and `rivers download` as FAIL until the first refresh (step 4): expected.
2. Until you run the release's bootstrap, `rws-update` pings `update` `/fail` with `host_files_changed`. Run it as in "a new release with changed host files" above, from the verified release directory, twice; the second run must say "0 change(s)". It links `rws-rivers-refresh` into `/usr/local/bin`, installs the service and the timer (the timer is **not** enabled) and creates `/srv/rws/public/data`, `/srv/rws/public/data/v1`, `/srv/rws/public/data/v1/rivers`, `/srv/rws/public/downloads` (0755 root) and `/var/lib/rws/rivers` (0700 root). **Check:**

   ```bash
   command -v rws-rivers-refresh
   stat -c '%n %a %U:%G' /srv/rws/public/data/v1/rivers /srv/rws/public/downloads /var/lib/rws/rivers   # 755 root, 755 root, 700 root
   systemctl is-enabled rws-rivers-refresh.timer                                                     # disabled
   ```
3. Dispatch `geo.yml` on `main` once (`docs/runbooks/geo-refresh.md` §2): it publishes the first `geo-YYYY-MM-DD` release with the river overlay, the reaches file and the ODbL download, each signed.
4. Run the first refresh and decide on the timer: `docs/runbooks/geo-refresh.md`, "Serving the rivers (P6b)" (a dry run, one real run, then `sudo systemctl enable --now rws-rivers-refresh.timer` when you are satisfied).
5. From outside: `scripts/verify-prod.sh <domain>`. The new lines are `rivers manifest`, `rivers tiles`, `rivers reaches`, `rivers download` and `rivers attribution`.
