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

> **Status:** P1 is planned, not built yet: `deploy/` is still empty. This section lists what the host needs and the order of the owner steps, so they can be prepared now. The scripts named here (`deploy/host/bootstrap.sh`, `rws-update`, `rws-deploy`, `rws-hc-sync`, `rws-reachability`, `scripts/verify-prod.sh`) arrive with P1b, together with the runbooks.

### 2.1 System requirements (A§3, §6.2 A3)

| Item | Requirement |
|---|---|
| VPS | One EU-region VPS: **4 vCPU, 8 GB RAM, ≥ 200 GB NVMe**, ≥ 1 Gbit/s, ≥ 20 TB/month traffic, IPv4 + IPv6 |
| OS | **Debian 13 "trixie"** (matches the distroless `debian13` images) |
| Provider features | Weekly snapshots, provider firewall (port 22 from your own IPs if static), a working break-glass console |
| Container runtime | Docker Engine 29.8.1 + Docker Compose 5.5.1 from Docker's signed apt repository (installed by bootstrap) |
| Domain | A registered domain with mailboxes `contact@` and `security@` |
| DNS | A/AAAA → the VPS; CAA `0 issue "letsencrypt.org"`; DNSSEC if available |
| Off-site backup | An EU S3-compatible bucket, versioned, **Object Lock (compliance, 30 days) enabled at creation** |
| Monitoring | A healthchecks.io account and project (free tier), with e-mail and phone/push integrations |

Expected use in year 1 is about 60 GB of disk; an alert fires at 75%.

### 2.2 Owner preparation (§6.2 A1–A7)

1. **A1** Answer the open decisions D1, D2, D5, D7 and D13 (`docs/plan/PHASES.md` §6.1).
2. **A2** Register the domain; create `contact@` and `security@` (used in the User-Agent, `security.txt` and the permission e-mails).
3. **A3** Order the VPS (2.1). Install your SSH key (FIDO2 `sk-ed25519` recommended) and test the console.
4. **A4** Set the DNS records.
5. **A5** Create the bucket and two keys: a **VPS key** (put, get, list; **no** `DeleteObjectVersion`, `BypassGovernanceRetention` or `PutObjectRetention`) and a **workstation key** for `restic forget --prune`. Generate the restic repository password and keep it offline (password manager + paper).
6. **A6** Create the healthchecks.io project and a project API key for `rws-hc-sync`.
7. **A7** Put the secrets on the VPS in `/etc/rws/secrets/` (directory 0700, files 0600): restic password, S3 keys, healthchecks API key, and a GHCR read token only if the repository is private. Never put them in the repository or in GitHub.

### 2.3 Install (P1b)

1. As root on a fresh Debian 13 host, run `deploy/host/bootstrap.sh` (idempotent). It creates the `ops` user (SSH keys only, no root login); nftables inbound 22 (rate-limited), 80, 443/tcp and 443/udp, and egress TCP 443 + DNS only for the container subnets; unattended-upgrades, needrestart, chrony and a sysctl baseline; Docker with `no-new-privileges`, `live-restore`, `icc: false` and the `local` log driver; and `/srv/rws/{raw,public,owner,tiles,backup}`.
2. Releases are built by `.github/workflows/release.yml` (SBOM, provenance, cosign keyless signing) and promoted by the owner through the `production` environment. Nothing is built on the VPS.
3. Deploy with `rws-deploy <release>`; afterwards the `rws-update` systemd timer (every 5 min) pulls new releases. Both verify the signed manifest and image signatures, smoke-test and roll back automatically on failure. Services: `caddy`, `capture`, `watchdog` and `backup` (`deploy/compose.yaml`).
4. Run `rws-hc-sync` to create the healthchecks, and enable `rws-backup.timer` (hourly restic to the bucket) and `rws-restore-drill.timer` (monthly).
5. Run `deploy/bin/rws-reachability` on the VPS (IPv4 and IPv6) and attach its output as `docs/reachability-<date>.md`.

### 2.4 Verify

```bash
scripts/verify-prod.sh <domain>   # TLS, security headers, /healthz, capture freshness, noindex
```

Then check `https://<domain>/status/capture.json` (every public spec fresh within 3× its cadence), `/status/ops.json` (a forced restore drill with 100 of 100 sha256 matches), and the owner checks of P1: a stopped `capture` alerts your phone, `restic forget --prune` with the VPS key fails, and capture is fresh again within 20 min after a reboot.

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
