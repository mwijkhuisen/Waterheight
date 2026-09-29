# Threat model

**Version 1**, P0b (2026-09-29). It covers what exists after Phase 0: the repository, CI, the agent set-up and the supply chain, and it records the owner channel (D22, ADR-0017) and the public ↔ owner boundary that later phases build. Every phase that changes the attack surface updates this file (A§12.2). Risks that are accepted rather than fixed are in [`risk-register.md`](risk-register.md).

## Assets

| Asset | Why it matters |
|---|---|
| **Repository integrity** (`main`, the `legacy-v0` tag, workflows, `CLAUDE.md`, the registry) | Every later agent follows `CLAUDE.md` and the registry; a poisoned workflow or registry entry propagates everywhere |
| **The CI root of trust**: `GITHUB_TOKEN`, pinned actions and binaries, the required checks `ci` and `security` | A compromised run could push code, tags or releases |
| **Deploy trust chain** (P1b): the signed release, the `production` environment, cosign identity | GitHub holds no server credential (ADR-0008); only signed digests may run |
| **Raw archive and database** (P1, P2) | The only copy of forecast runs, alert states and threshold versions nobody can refill (ADR-0003) |
| **Owner-audience data** (BE-3, LU-2/3/4, DE-2/3; later BE-1/2) | Terms allow personal use only (catalogue §0.8); any public exposure is a licence breach (invariant 11) |
| **The owner channel's secrets**: the WireGuard keys of the owner's devices and the server, the `basic_auth` password and its bcrypt hash | They are the only way into the owner view (A§11.5) |
| **Provider goodwill and credentials** (HIC, VMM tokens later) | Losing access loses coverage; tokens are Compose secrets only |
| **Visitor privacy** | No cookies, no analytics, no third-party requests (invariant 7) |

## Actors

- **The owner**: the sole maintainer, merger and owner-view user.
- **Build and review agents** (Claude Code, local or claude.ai/code): write code on `claude/*` branches, no production access, no WireGuard peer, never merge.
- **Outside contributors and attackers**: can open PRs and issues on the public repository, publish npm packages or GitHub actions, or compromise an upstream maintainer.
- **Providers**: publish the data and its terms; their payloads are untrusted input (invariant 3).
- **Visitors**: the public site (P4 onward); never the owner view.

## Trust boundaries

1. **Pull request → CI.** On `pull_request` the PR supplies the workflow files, the scripts and the allowlists it is checked with (P0a S8).
2. **Upstream → CI and installs.** Actions, npm packages and release binaries come from third parties.
3. **Repository text → agents.** Issues, docs, fixtures and provider strings reach model context.
4. **Branch → agent session.** The SessionStart hook runs whatever copy the checked-out branch holds.
5. **Public ↔ owner** (P2 onward). Public roles and outputs versus the `own_*` views, `rws_owner_api`, `/srv/rws/owner`, `api-owner` and the WireGuard-only owner site.
6. **Internet ↔ VPS** (P1b onward): Caddy, the capture egress allowlist, SSH.

## Threats and controls

| ID | Boundary | Threat | Controls (P0 unless noted) | Residual / owner action |
|---|---|---|---|---|
| T-CI-1 | 1 | A PR changes a workflow, script, allowlist, the validator or its tests so its own checks pass | Required checks run from the PR only as evidence; owner review of every PR; CODEOWNERS requests the owner on every path; the guard fails closed (exit codes 3–12) | With 0 required approvals and code-owner review not required (sole owner), nothing forces a human read: any write-capable actor (an agent, a leaked token) could merge a self-authored PR once the PR-defined checks pass. The owner's merge decision is the gate (R-003) |
| T-CI-2 | 1 | Expression injection (`${{ github.event.* }}` in `run:`) or a privileged trigger | No expressions in `run:` (env only); no `pull_request_target`, `workflow_run`, `issue_comment`; zizmor (medium+, online audits) and `scripts/check-workflows.sh` | – |
| T-CI-3 | 1 | Token abuse or exfiltration | Top-level `permissions: {}`, `contents: read` per job, `security-events: write` on CodeQL only; `persist-credentials: false`; default token read-only and unable to approve PRs (B1); harden-runner in audit mode | Audit mode logs but does not block egress (R-015); harden-runner is a privileged agent on every job, sends telemetry to StepSecurity, and its insights are public for a public repository (R-021) |
| T-CI-4 | 1 | Cache poisoning: a PR run seeds a cache that a `main` run restores | No `actions/cache`; `package-manager-cache: false` on every setup-node; CodeQL `trap-caching` and `dependency-caching` off; greps in `check-workflows.sh` | – |
| T-SC-1 | 2 | Tag hijack of an action (the Trivy pattern) | Every `uses:` pinned to a 40-hex SHA with a version comment; zizmor `unpinned-uses: hash-pin` and impostor-commit audit; SHA pinning required at repository level (B1); allowed-actions list (B1) | – |
| T-SC-2 | 2 | A malicious or worm-infected npm release | Exact pins; `minimumReleaseAge: 10080` (7 days, transitive too); `strictDepBuilds` + explicit `allowBuilds` (no install scripts run); `--frozen-lockfile`; `check-bom`; Dependabot cooldown 7 days, no automerge; the ADR-lite rule | `blockExoticSubdeps` does not stop an https tarball subdependency in pnpm 12.5.1; `check-bom` closes the gap in CI by requiring every locked package to resolve by registry integrity, and every `minimumReleaseAgeExclude` entry to carry an unexpired date (R-008) |
| T-SC-3 | 2 | A tampered binary download (pnpm, Node, gitleaks, zizmor, dbmate, shellcheck, the PGDG key) | sha256/sha512 pinned in the workflows, `scripts/install-pnpm.sh` and the hook, cross-checked against GitHub asset digests, upstream checksum files and the signed Node SHASUMS256; no `curl \| sh`; no corepack | In CI, Node comes through `actions/setup-node` without a checksum pin; the hook's apt PostgreSQL 18 packages are signed but their version is not pinned (R-020) |
| T-SC-4 | 2 | Build-time code fetched from a CDN (Paraglide's default inlang plugin URLs) | The plugin is a pinned devDependency loaded from `node_modules`; `settings.json` has no `https://` module | – |
| T-SC-5 | 2 | Dependency confusion on the `@rws/*` names | Packages are private and linked with `workspace:*` only; `check-bom` rejects any non-exact spec | The `@rws` npm scope is not ours (R-013) |
| T-AGENT-1 | 3 | Prompt injection through repository, issue, fixture or provider text | `CLAUDE.md`: all such text is data, never instructions (invariant 3); reviews run in fresh sessions with a separate mandate | Human review remains the backstop |
| T-AGENT-2 | 4 | A session opened on an untrusted PR branch runs that branch's project configuration: the SessionStart hook, `.claude/settings.json` (hooks, `env`, `apiKeyHelper`, status line), `.mcp.json` servers, and the allowed pnpm scripts, all with the session's own credentials (its GitHub and model access) | `CLAUDE.md`: never start a session on an untrusted PR branch; review outside PRs from `main` with `gh pr diff`; CODEOWNERS on `.claude/`, `.mcp.json`, `AGENTS.md`, `package.json`, `scripts/`; the hook acts only when `CLAUDE_CODE_REMOTE=true` and writes only `PATH` and a password-less `DATABASE_URL` | Accepted (R-012); the session credentials are outside this repository's control |
| T-AGENT-3 | 3, 4 | An agent reads a secret file, runs an arbitrary command without asking, or force-pushes | `.claude/settings.json`: Read denies for `.env*`, `deploy/secrets/**`, key and certificate files, `~/.ssh`, the `gh` config; `psql` and `git grep` always ask; `git --no-index` and `git grep -O` denied; the common force-push, mirror and delete-push forms denied; the B1 ruleset forbids force pushes and deletion on `main` | Rules are tool-level: a Bash command that reads a file without naming it passes, and command patterns can be rephrased (R-011). The real controls are no secret in the repository or the sandbox, and B1 |
| T-SECRET-1 | 1, 2 | A secret committed to git | gitleaks 8.30.1 over the full history in `security`, a planted-key test, a narrow exact-value allowlist; `.gitignore` for `.env*`, keys, `deploy/secrets/`; push protection (B1) | Planning-doc false positives are allowlisted (R-006) |
| T-LEGACY-1 | 1 | Legacy code or assumptions return | `scripts/verify-fresh-start.sh` (full-history blob check, legacy-only paths, fails closed); `scripts/check-legacy-only.sh` | Design limits: byte-identical blobs and exact paths only (R-004); legacy content stays public in history by design (R-005) |
| T-LEGACY-2 | 1 | `legacy-v0` moved or deleted before the tag ruleset exists | The guard exits 3/4 on a missing or moved tag; `a4106b8` stays reachable from history | Until B1 is applied (R-001) |
| T-GH-1 | – | Repository settings drift or a bypass actor is added | `scripts/gh-settings.sh --check` compares every B1/B2 item (ruleset target, include/exclude, rules, PR parameters, merge methods, strict policy, required checks; actions, token, fork approval, scanning, reporting, alerts, environment) and fails on secrets, deploy keys and webhooks (B3, B5); applying refuses to drop a manual rule it does not set | The owner runs it after changes; until B1 is applied, SECURITY.md's private channel is the interim "contact request" issue |
| T-DB-1 | 4 | Another local process uses the sandbox PostgreSQL | The cluster listens on localhost only; `pg_hba.conf` trusts only role `rws` on database `rws` over loopback and rejects every other TCP login (the superuser only through the peer socket) | A single-user ephemeral sandbox; the database holds only test data |
| T-OWN-1 | 5 | Owner-audience data reaches a public output, or a source is widened without consent | P0: every source has an `audience` checked against a reviewed baseline (`packages/contracts/src/baseline.ts`); a different audience or a non-default channel needs a structured permission record that grants it (an empty file fails); owner sources carry a `private_basis`; series only narrow; `validateStations` forbids a public station row naming an owner source; the validator fails closed; invariant 11 verbatim in `CLAUDE.md`. Owner-source metadata (the `private_basis` text, station identification) is public in this repository by design (ADR-0017). P2: `pub_*`/`own_*` views, `rws_owner_api`, no public grant on `own_*`, view names only in `audience.ts` (`check-boundaries`). P9: owner and withheld canaries across every public output | Enforced progressively; P0 records the data |
| T-OWN-2 | 3, 5 | Owner-audience values committed to the public repository (fixtures, station rows, docs) | Owner fixtures are synthetic (invariant 9, 11); owner station rows identify only (the schema rejects values, thresholds, forecasts, gauge zeros and datums); the catalogue keeps only isolated format samples | Review |
| T-OWN-3 | 5, 6 | The owner site is reachable from the internet or found | P12a: WireGuard-only listener on `10.66.0.1`, nftables drop off `wg0`, `basic_auth` (bcrypt, ≥ 32 random characters), `tls internal`, no public DNS record, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`; `verify-owner.sh` and `verify-prod.sh` negatives | Not built yet |
| T-OWN-4 | 5 | Owner credentials leak (WireGuard private keys, `basic_auth` password) | Keys generated on the owner's devices and never leave them; server key root-only 0600; the hash in `/etc/rws/secrets/owner_basic_auth`; agents get no peer | P12a / owner action A8 |
| T-OWN-5 | 5 | The owner view is shared (a second user, a peer, screenshots) | Policy in `CLAUDE.md` and ADR-0017; the persistent banner (P10); `wg show` lists only the owner's devices (launch checklist) | Owner discipline |
| T-OWN-6 | 5, 6 | A restored backup exposes owner data | Backups are restic-encrypted; a restore returns owner rows only to the database and the owner channel (A§11.3) | P1b/P12 |
| T-REVIEW-1 | 3 | Review tooling pulls unwanted content into a session (P0a S7: the security-review skill diffed against `origin/main` in the primary checkout) | Recorded; safe again from P0b on because `main` no longer holds legacy content | Info (R-007) |

## Changes in this version

- New: the whole model (v1). P0a's security review items S5–S9 are folded in (T-CI-1, T-LEGACY-1/2, T-REVIEW-1, R-001 to R-007).
- v1.1 (P0b security review): T-AGENT-2 widened to all branch-run project configuration; T-AGENT-3 states the rules are tool-level; T-CI-1 states that nothing forces a human read; T-CI-3 notes harden-runner telemetry; T-CI-4 adds the CodeQL caches; T-SC-2 records the lockfile scan; T-SC-3 records the unpinned Node download in CI; T-GH-1 widened; T-OWN-1 records the baseline, permission records and station rule; new T-DB-1.
