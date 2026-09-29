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
| **A6** | healthchecks.io: an account, a project with e-mail and phone/push integrations, and the project's **ping key** and an **API key** (read-write) | Step 7 creates the 15 checks; the project page lists them |
| **A7** | The secrets on the VPS (step 3) | `sudo ls -l /etc/rws/secrets` |
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
- **Files:** `/srv/rws` and `/etc/rws/secrets` with the contract owners and modes.
- **Settings:**
  - a generated `rws_x_api_key`, and a template `/etc/rws/rws.env`;
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

Use `sudoedit /etc/rws/secrets/<name>` for each file, then **run `bootstrap.sh` again** (`sudo /usr/local/lib/rws/deploy/host/bootstrap.sh`): it resets every secret to `root:<gid> 0440`.

| File | Content | Read by |
|---|---|---|
| `hc_ping_key` | the healthchecks.io project **ping key** | capture, watchdog (gid 61001); the host timers as root |
| `rws_x_api_key` | generated by bootstrap. Keep it; C7 tells RWS the value | capture (gid 61002) |
| `restic_password` | the repository password from A5 | backup (gid 61003) |
| `s3_credentials` | `[default]`, then `aws_access_key_id = …`, then `aws_secret_access_key = …` (the **VPS key**) | backup (gid 61003) |
| `ghcr_token` | only if the repository were private (it is public, D7) | – |

Compose mounts a file secret with its **host** owner and mode (it ignores `uid`, `gid` and `mode` for file secrets). A root-owned 0600 file would be unreadable to the uid-65532 containers. So each file is readable by its own group only, and only the consuming container has that group (`group_add` in `deploy/compose.yaml`) and mounts it. The directory itself is `root 0700`.

**Check:** `sudo stat -c '%n %a %U:%G' /etc/rws/secrets/*` shows every file `440 root:rws-*`.

**Changing a secret later** (a new ping key, a rotated S3 key): edit it in place with `sudoedit`, never by replacing the file (`mv`, `install`, or an editor that renames). Compose bind-mounts each file secret by its inode, so a running container keeps reading a replaced file's old content. An in-place edit of `hc_ping_key` takes effect at the next ping; `rws_x_api_key` is read when capture starts, so run `sudo docker restart rws-capture-1` after changing it. If a file was replaced, `sudo docker restart rws-capture-1 rws-watchdog-1` mounts the new one. The backup job reads `restic_password` and `s3_credentials` in a fresh container on every run. Redeploying the current release (`rws-deploy`) does not help here: `up -d` recreates a container only when its configuration changes.

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

It verifies the manifest and all three images, pulls by digest, runs `up -d`, and smoke-tests: `/healthz` 200 over real TLS and a fresh `capture.json`. Caddy gets its Let's Encrypt certificate in the first minute, so A4 must be in place. If the first deploy fails, it says why and leaves the containers running. Fix the cause (DNS, B4, `rws.env`), then run `rws-deploy <tag>` again.

**Check:**

- `sudo docker compose -p rws ps`: caddy, capture and watchdog show `healthy`;
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
deploy/bin/rws-hc-sync --dry-run                        # the 15 checks it will create
deploy/bin/rws-hc-sync --key-file ~/secure/hc_api_key   # create or update them
```

Keep the API key off the VPS: it can delete the checks that watch the VPS. If you run it on the VPS instead, delete `/etc/rws/secrets/hc_api_key` afterwards.

**Check:** the project lists 15 checks. After 10 minutes, `cap-*`, `update`, `watchdog`, `cert` and `disk` are green, and `backup` turns green at the next :17.

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
