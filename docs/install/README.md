# Installing Waterheight

How to install and run this repository, based on phase P0 (foundation, merged) and phase P1 (flight recorder in production, planned). The binding sources are `docs/plan/PHASES.md` (P0, P1, §6.2) and `docs/plan/ARCHITECTURE.md`; the exact version pins are in the bill of materials in `CLAUDE.md`. If this page and those files disagree, those files win.

- [1. Development machine (P0)](#1-development-machine-p0)
- [2. Production host (P1)](#2-production-host-p1)
- [3. Troubleshooting](#3-troubleshooting)

---

## 1. Development machine (P0)

### 1.1 System requirements

| Requirement | Version | Notes |
|---|---|---|
| OS | Linux x64 or arm64 (Debian 13 / Ubuntu 24.04 tested) | macOS works for the Node part; the scripts assume bash and GNU tools |
| Node.js | **26.10.0** exactly (`.node-version`; `engines`: `>=26.10.0 <27`) | Node 26 runs `.ts` through type stripping and has native `Temporal`. **corepack is not bundled**; do not use it |
| pnpm | **12.5.1** (`packageManager` in `package.json`) | Install with `scripts/install-pnpm.sh` (sha512-pinned native binary), not with `npm i -g pnpm` |
| PostgreSQL | **18** (CI uses `postgres:18.6-trixie`) | Only for the integration tests. The cluster must use the builtin `C.UTF-8` locale |
| dbmate | 2.36.0 | Only for `scripts/dbmate-roundtrip.sh` |
| shellcheck | 0.11.0 | Optional; CI lints `scripts/*.sh` |
| git, curl, bash ≥ 5 | any recent | |
| Disk / RAM | ~1 GB for `node_modules`; 4 GB RAM is plenty | |

TypeScript (6.0.3), Biome, Vitest, Vite and every other npm package are installed by pnpm from the lockfile; do not install them globally. **TypeScript 7 is forbidden.**

### 1.2 Quick path: claude.ai/code

In a claude.ai/code session everything below runs automatically: the SessionStart hook `.claude/hooks/session-start.sh` installs Node 26.10.0, pnpm 12.5.1 and PostgreSQL 18 (cluster `18/rws` on port 5433), sets `PATH` and `DATABASE_URL`, and runs `pnpm install --frozen-lockfile`. Skip to [1.6](#16-verify).

### 1.3 Node.js and pnpm

```bash
git clone https://github.com/mwijkhuisen/Waterheight.git
cd Waterheight

# Node 26.10.0: use your version manager (fnm, nvm, mise …) with .node-version,
# or the official tarball from nodejs.org (check its SHASUMS256).
node --version            # v26.10.0

# pnpm 12.5.1, checked against the sha512 pin in the script:
scripts/install-pnpm.sh "$HOME/.local/share/rws-tools"
export PATH="$HOME/.local/share/rws-tools/bin:$PATH"
pnpm --version            # 12.5.1
```

### 1.4 Dependencies

```bash
pnpm install --frozen-lockfile
```

This is the **only** supported install command. The lockfile is never rewritten. `pnpm-workspace.yaml` enforces the supply-chain policy (ADR-0014): a 7-day minimum release age, `strictDepBuilds`, an explicit `allowBuilds` list and `blockExoticSubdeps`. A "too new" or "build script not allowed" error is the policy working, not a bug; see the dependency policy in `CLAUDE.md`.

### 1.5 PostgreSQL 18 (integration tests only)

Install PostgreSQL 18 from the signed `apt.postgresql.org` repository (Debian/Ubuntu), then create a local cluster like the hook does:

```bash
sudo pg_createcluster 18 rws --port 5433 --locale C.UTF-8 -- \
  --locale-provider=builtin --builtin-locale=C.UTF-8
sudo pg_ctlcluster 18 rws start
sudo -u postgres psql -p 5433 -c "CREATE ROLE rws LOGIN PASSWORD 'rws'"
sudo -u postgres psql -p 5433 -c "CREATE DATABASE rws OWNER rws"

export DATABASE_URL='postgres://rws:rws@localhost:5433/rws?sslmode=disable'
```

Alternatively run the CI image: `docker run -d -p 5433:5432 -e POSTGRES_USER=rws -e POSTGRES_PASSWORD=rws -e POSTGRES_INITDB_ARGS='--locale-provider=builtin --builtin-locale=C.UTF-8' postgres:18.6-trixie` (pin the digest from `CLAUDE.md`). `?sslmode=disable` is required against a local server without TLS. Keep this database throwaway: `scripts/dbmate-roundtrip.sh` refuses any non-local URL.

### 1.6 Verify

```bash
pnpm check                  # Paraglide compile, Biome, tsc -b, unit tests, check-bom, check-boundaries
pnpm test:integration       # needs DATABASE_URL; fails on zero tests
pnpm build                  # server -> apps/server/dist, web -> apps/web/dist
scripts/healthz-smoke.sh    # GET /healthz -> 200 {"status":"ok"}
scripts/dbmate-roundtrip.sh # optional: dbmate up/down/up on a fixture migration
```

This is the P0 acceptance criterion: on a clean checkout `pnpm install --frozen-lockfile && pnpm check && pnpm -F web build` is green and the server serves `/healthz`.

### 1.7 Run

```bash
HOST=127.0.0.1 PORT=8080 node apps/server/dist/main.js api   # GET /healthz
pnpm -F web build                                              # static site in apps/web/dist (NL at /, EN at /en/)
```

In P0 only the `api` role runs; `capture`, `load`, `publish`, `replay` and `watchdog` exit 2 until their phase, and unknown roles exit 64.

### 1.8 GitHub repository settings (owner, once)

After cloning into a new repository, the owner applies the settings of `docs/github-settings.md` (PHASES §6.2 B1–B6): `scripts/gh-settings.sh`, then `scripts/gh-settings.sh --check`; a `production` environment with the owner as required reviewer; **no GitHub secrets** (cosign uses OIDC). GitHub Actions must be able to run (public repository or a spending limit).

---

## 2. Production host (P1)

> **Status:** this section follows P1a and P1b as merged into `main` ([mwijkhuisen/Waterheight#35](https://github.com/mwijkhuisen/Waterheight/pull/35)). The authoritative, tested commands are in its runbooks, `docs/runbooks/bootstrap.md` and `docs/runbooks/owner-checks.md`; if a step here and a runbook disagree, the runbook wins. Other runbooks: `deploy-rollback.md`, `recorder-down.md`, `restore.md`, `disk-full.md`, `lost-ssh.md`.

### 2.1 System requirements (A§3, §6.2 A3)

| Item | Requirement |
|---|---|
| VPS | One EU-region VPS: **4 vCPU, 8 GB RAM, ≥ 200 GB NVMe**, ≥ 1 Gbit/s, ≥ 20 TB/month traffic, IPv4 + IPv6 |
| OS | **Debian 13 "trixie", amd64** (matches the distroless `debian13` images; the pinned cosign and Docker packages are amd64) |
| Provider features | Weekly snapshots, provider firewall (port 22 from your own IPs if static), a working break-glass console |
| Container runtime | Docker Engine 29.8.1, Compose 5.5.1, containerd 2.3.5 and cosign 3.1.3, pinned and installed by `bootstrap.sh`; install nothing yourself |
| Domain | A registered domain with mailboxes `contact@` and `security@` |
| DNS | A/AAAA → the VPS; CAA `0 issue "letsencrypt.org"`; DNSSEC if available |
| Off-site backup | An EU S3-compatible bucket, versioned, **Object Lock (compliance, 30 days) enabled at creation** |
| Monitoring | A healthchecks.io account and project (free tier), with e-mail and phone/push integrations |

Expected use in year 1 is about 60 GB of disk; an alert fires at 75%.

### 2.2 Owner preparation, step by step (§6.2 A1–A6, B1–B2)

None of these steps depends on P1 code, so they can be done now. Tick each box and keep the notes (provider, region, key IDs, never the secrets themselves) in your password manager. Deadlines are from PHASES §6.2; the recorder is meant to be live by **10-02**.

#### Step 1 · Decisions (A1, by 09-25)

Record your answers in the issue for P1 (defaults from PHASES §6.1):

- [ ] **D1** commercial use: default *non-commercial* (it is stated in every permission e-mail).
- [ ] **D2** domain name and contact mailboxes (step 2).
- [ ] **D5** off-site backup: an EU S3-compatible bucket with versioning and Object Lock (compliance, 30 days), restic-encrypted.
- [ ] **D7** repository visibility: default *public* (free CodeQL, secret scanning and Actions minutes; GHCR images need no pull token).
- [ ] **D13** the bucket provider: your choice, as long as it offers an EU region, the S3 API, versioning and Object Lock.

#### Step 2 · Domain and mailboxes (A2, by 09-25)

- [ ] Register the domain at a registrar that supports DNSSEC and CAA records.
- [ ] Enable two-factor authentication on the registrar account and lock the domain against transfer.
- [ ] Create the mailboxes (or aliases to your inbox) `contact@<domain>` and `security@<domain>`.
- [ ] Send a test mail to each and confirm it arrives.
- [ ] Check: `dig +short MX <domain>` returns your mail provider.

#### Step 3 · SSH key (before ordering the VPS)

- [ ] On your workstation, create a hardware-backed key if you have a FIDO2 security key:
  ```bash
  ssh-keygen -t ed25519-sk -O resident -C "rws-ops" -f ~/.ssh/rws_ops
  ```
  Without one: `ssh-keygen -t ed25519 -C "rws-ops" -f ~/.ssh/rws_ops` with a strong passphrase.
- [ ] Keep a second (backup) key or security key in a safe place; losing the only key locks you out (the console in step 4 is the break-glass).
- [ ] Copy only the `.pub` file anywhere. The private key never leaves your device.

#### Step 4 · Order the VPS (A3, by 09-27)

- [ ] Order: **EU region, 4 vCPU, 8 GB RAM, ≥ 200 GB NVMe, ≥ 1 Gbit/s, ≥ 20 TB/month traffic, IPv4 + IPv6, Debian 13 "trixie" amd64**.
- [ ] Add your SSH public key from step 3 during ordering.
- [ ] Enable **weekly provider snapshots**.
- [ ] Enable the **provider firewall**: inbound 22/tcp (only from your own IPs if they are static), 80/tcp, 443/tcp and 443/udp; everything else dropped.
- [ ] Open the provider's web/VNC **console** once and confirm you can reach a login prompt (break-glass access).
- [ ] Write down the IPv4 and IPv6 addresses.
- [ ] Check from your workstation:
  ```bash
  ssh -i ~/.ssh/rws_ops root@<ipv4> 'grep VERSION_CODENAME /etc/os-release; dpkg --print-architecture; nproc; free -g; df -h /; ip -br a'
  ```
  Expect `trixie`, `amd64`, 4 CPUs, ~8 GB, ≥ 200 GB and a global IPv4 and IPv6 address. Do nothing else on the host: `bootstrap.sh` (P1b) sets up users, firewall and Docker.

#### Step 5 · DNS (A4, by 09-27)

- [ ] `A <domain> → <ipv4>` and `AAAA <domain> → <ipv6>` (and the same for `www` if you want it).
- [ ] `CAA <domain> 0 issue "letsencrypt.org"`.
- [#### Step 6 · Off-site backup bucket (A5, by 09-28)

- [ ] At your D13 provider, create a bucket in an EU region with **versioning and Object Lock enabled at creation** (it cannot be added later), default retention **COMPLIANCE, 30 days**, reachable on port **443** (the firewall allows no other port).
- [ ] Create the **VPS key** with the policy in `deploy/host/s3-vps-key-policy.json` (replace `RWS_BUCKET` with your bucket name). It may put, get, list and delete *objects* (restic removes its own lock files; under versioning that only adds a delete marker), but **not** delete object versions, bypass or change retention, change the lock or versioning configuration, or add lifecycle rules.
- [ ] Create the **workstation key** for `restic forget --prune` (7 daily, 8 weekly, 12 monthly). It never goes on the VPS.
- [ ] Generate the restic repository password: `openssl rand -base64 48`. Store it in your password manager **and** on paper; without it the backups cannot be read.
- [ ] Write down the endpoint host, region (e.g. `fr-par`, `eu-central-1`) and bucket name for step 13.
- [ ] Check: the provider console shows versioning on and the default retention. The real proof is `object-lock-prune.sh` in step 14.

#### Step 7 · healthchecks.io (A6, by 09-28)

- [ ] Create an account (free tier) with two-factor authentication, and a project, e.g. `rws`.
- [ ] Add integrations: **e-mail** and **phone/push**; send a test notification to each.
- [ ] From the project settings, copy two keys: the **ping key** (goes on the VPS, step 12) and a read-write **API key** (stays on your workstation, step 16). Create no checks by hand: `rws-hc-sync` creates all 15.

#### Step 8 · GitHub environment (B2, before the first release)

- [ ] `scripts/gh-settings.sh --check` passes (B1).
- [ ] Environment **`production`**: required reviewer = you; deployment branch = `main`; **no secrets**. Add no repository secrets either (B5): cosign uses GitHub OIDC and GHCR pushes use `GITHUB_TOKEN`.

### 2.3 Install and go live (P1b), step by step

The order below is the fastest way to live capture (`docs/runbooks/bootstrap.md`). Commands with `sudo` run on the VPS as `ops`; step 10 and 11 run as root.

#### Step 9 · Merge and promote the release

- [ ] P1a and P1b are merged into `main`, so `release.yml` has built, signed and attested the three images (`server`, `web`, `backup`).
- [ ] In GitHub → Actions, **approve the `promote` job** (environment `production`). It publishes the release `prod-<UTC timestamp>` with `release-manifest.json`, its sigstore bundle and `deploy-bundle.tar.gz`.
- [ ] **B4:** set the three GHCR packages `waterheight/server`, `web` and `backup` to **public** (package settings → Change visibility). Check:
  ```bash
  curl -s 'https://ghcr.io/token?scope=repository:mwijkhuisen/waterheight/server:pull' | grep -q '"token"' && echo public
  ```

#### Step 10 · Fetch and verify the release on the VPS (never a git checkout)

- [ ] `ssh root@<ipv4>` (or `sudo -i`), in an interactive shell.
- [ ] Paste the block from **`docs/runbooks/bootstrap.md` §1** exactly. It downloads cosign (sha256-pinned), the manifest, its signature and the deploy bundle, verifies the signature against the release workflow's identity and the bundle's sha256, and unpacks it into `/root/rws-release/bundle`. It is kept in the runbook only, because a test checks it against `release.yml`.
- [ ] Check: `Verified OK`, `deploy-bundle.tar.gz: OK`, and the last line reads `VERIFIED: release prod-…`. On `STOP`, run nothing from that directory and find out why.

#### Step 11 · Bootstrap the host

```bash
cd /root/rws-release
bundle/deploy/host/bootstrap.sh --dry-run   # shows what it would change
bundle/deploy/host/bootstrap.sh             # applies it
bundle/deploy/host/bootstrap.sh             # must report "0 change(s)"
```

It creates the `ops` user (NOPASSWD sudo, your key copied over), makes SSH keys-only with no root login, sets UTC, chrony, AppArmor, unattended-upgrades (reboot at 03:40 UTC when needed), the sysctl baseline and the `rws-firewall` service; installs the pinned Docker and cosign; creates `/srv/rws` and `/etc/rws/secrets`; generates `rws_x_api_key` and a template `/etc/rws/rws.env`; and installs the host scripts and timers.

- [ ] **Before closing the root session**, log in as `ops` in a second terminal: `ssh -i ~/.ssh/rws_ops ops@<ipv4>`. From now on root login is off.
- [ ] Check:
  ```bash
  sudo systemctl is-active rws-firewall docker chrony
  sudo nft list table inet rws | head
  sudo docker version --format '{{.Server.Version}}'   # 29.8.1
  systemctl list-timers 'rws-*'
  ```

#### Step 12 · Secrets (A7), before `rws.env`

A complete `rws.env` starts the deploys, so the secrets go first. Edit each file **in place** with `sudoedit /etc/rws/secrets/<name>` (never `mv`, `install` or an editor that replaces the file: containers keep reading the old inode).

| File | Content |
|---|---|
| `hc_ping_key` | the healthchecks.io **ping key** (step 7) |
| `rws_x_api_key` | already generated by bootstrap; keep it (C7 tells RWS the value) |
| `restic_password` | the repository password (step 6) |
| `s3_credentials` | three lines: `[default]`, `aws_access_key_id = …`, `aws_secret_access_key = …` with the **VPS key** |

- [ ] Fill the three files above; `ghcr_token` is not needed (the repository is public).
- [ ] Run bootstrap again, which resets the owners and modes: `sudo /usr/local/lib/rws/deploy/host/bootstrap.sh`.
- [ ] Check: `sudo stat -c '%n %a %U:%G' /etc/rws/secrets/*` shows every file `440 root:rws-*`.

#### Step 13 · Fill `/etc/rws/rws.env`

`sudoedit /etc/rws/rws.env`, plain `KEY=VALUE` lines without quotes:

| Key | Value |
|---|---|
| `RWS_DOMAIN` | your domain, e.g. `rivierstanden.nl` |
| `RWS_CONTACT_EMAIL` | `contact@<domain>` (sent in every provider request's User-Agent) |
| `RWS_PUBLIC_IPV4`, `RWS_PUBLIC_IPV6` | detected by bootstrap; compare them with your DNS records (step 5): the site listens only on these |
| `RWS_RESTIC_REPOSITORY` | `s3:https://<endpoint>/<bucket>/restic` |
| `RWS_S3_REGION` | the bucket's region |
| `RWS_BACKUP` | leave `off` until step 15 |

- [ ] Check: `sudo rws-update --dry-run` no longer says "rws.env is not complete".

#### Step 14 · First deploy

Wait up to 5 minutes for `rws-update.timer`, or deploy now with the tag verified in step 10:

```bash
tag=$(sudo grep -o '"tag": *"prod-[0-9]\{8\}T[0-9]\{6\}Z"' /root/rws-release/release-manifest.json | grep -o 'prod-[0-9]\{8\}T[0-9]\{6\}Z')
sudo rws-deploy "$tag"
```

It verifies the manifest and the three images, pulls by digest, starts the services and smoke-tests `/healthz` over real TLS plus a fresh `capture.json`. Caddy gets its Let's Encrypt certificate in the first minute, so DNS (step 5) must resolve. If it fails, it says why; fix the cause (DNS, B4, `rws.env`) and run `rws-deploy "$tag"` again.

- [ ] Check:
  ```bash
  sudo docker compose -p rws ps                       # caddy, capture, watchdog: healthy
  curl -s https://<domain>/status/capture.json | head -c 300
  sudo cat /var/lib/rws/current
  ```

#### Step 15 · Backups

```bash
sudo sed -i 's/^RWS_BACKUP=off$/RWS_BACKUP=on/' /etc/rws/rws.env
sudo rws-backup --init                 # once: creates the restic repository
sudo rws-backup                        # first backup (then hourly at :17)
sudo rws-restore-drill --force         # restores 100 random objects and compares them
sudo /usr/local/lib/rws/deploy/tests/object-lock-prune.sh   # the VPS key cannot remove versions
```

- [ ] Check: `curl -s https://<domain>/status/ops.json` shows `last_backup` and a drill with `"sampled":100,"matched":100`; `object-lock-prune.sh` prints five PASS lines.

#### Step 16 · Healthchecks, from your workstation

```bash
deploy/bin/rws-hc-sync --dry-run                        # lists the 15 checks
deploy/bin/rws-hc-sync --key-file ~/secure/hc_api_key   # creates or updates them
```

Keep the API key off the VPS (it can delete the checks that watch the VPS).

- [ ] Check: the project lists 15 checks; after 10 minutes `cap-*`, `update`, `watchdog`, `cert` and `disk` are green, and `backup` after the next :17.

#### Step 17 · Verify from outside

```bash
scripts/verify-prod.sh <domain>   # from a checkout after pnpm install --frozen-lockfile; no SSH
```

- [ ] Every line is PASS (IPv6 may be N/A only if your own machine has no IPv6).

#### Step 18 · Owner checks (`docs/runbooks/owner-checks.md`)

Paste each output into the P1 issue (#16).

- [ ] **Reachability** (as `ops`): `rws-reachability --out /tmp/reachability.md`. Every required row PASS (or `n/a (no AAAA)`); a required FAIL goes into `docs/risk-register.md` with its fallback. The agent commits the table as `docs/reachability-<date>.md`.
- [ ] **Phone alert:** `sudo docker compose -p rws stop capture`; wait for the alert (about 15–30 min); `sudo docker compose -p rws start capture`; the check turns green within one cadence.
- [ ] **Reboot:** `sudo reboot`; within 20 min `capture.json` is fresh, `verify-prod.sh` passes and the timers are scheduled, with no manual step.
- [ ] **Negative deploy** (after at least two releases): `sudo /usr/local/lib/rws/deploy/tests/negative-deploy.sh` prints four PASS lines (unsigned and wrongly signed images refused; an injected smoke failure rolls back).
- [ ] **Capacity:** after 48 h, give the agent the owner-audience bytes/day aggregate (the `jq` command in owner-checks §7) for `docs/capacity.md`.

### 2.4 Later: updates and rollbacks

- A merge to `main` plus your approval of `promote` is the whole deploy: `rws-update.timer` verifies and deploys within 5 minutes and rolls back on a failed smoke test (`docs/runbooks/deploy-rollback.md`).
- When a release changes host files, the `update` check fails with `host_files_changed`. Then run that release's bootstrap: `sudo /var/lib/rws/releases/<tag>/deploy/host/bootstrap.sh --dry-run`, then without `--dry-run`. Never run the bootstrap of an older release than the last one you ran.
- Changing a secret: `sudoedit` it in place; after changing `rws_x_api_key`, `sudo docker restart rws-capture-1`.
- Something red: start with `docs/runbooks/recorder-down.md`; the other runbooks cover restore, disk full and lost SSH access.

The owner view (WireGuard, `basic_auth`, `owner.<domain>`) is not part of P1; it is set up in P12a (§6.2 A8).

---

estic forget --prune` with the VPS key fails, and capture is fresh again within 20 min after a reboot.

The owner view (WireGuard, `basic_auth`, `owner.<domain>`) is not part of P1; it is set up in P12a (§6.2 A8).

---

## 3. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `pnpm: command not found` or a pnpm download at run time | Install pnpm with `scripts/install-pnpm.sh`, not through npm or corepack |
| `ERR_PNPM_…` about release age | The 7-day `minimumReleaseAge` rule; wait, or follow the owner-only override in `CLAUDE.md` |
| `pnpm install` wants to change the lockfile | Always use `--frozen-lockfile`; a lockfile change belongs in its own PR |
| `check-bom` fails | A pin differs from the bill of materials in `CLAUDE.md`; fix the pin, not the table, unless the change is intended |
| Integration tests: connection refused or TLS error | `DATABASE_URL` unset, wrong port (5433), or missing `?sslmode=disable` |
| Collation or locale errors | The cluster was not created with `--locale-provider=builtin --builtin-locale=C.UTF-8`; recreate it |
| Node refuses a `.ts` import | Node 26 type stripping needs the `.ts` extension and erasable syntax only (no enums or namespaces) |
