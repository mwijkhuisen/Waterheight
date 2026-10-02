# GitHub settings (owner actions B1–B6)

The repository settings live in code: [`scripts/gh-settings.sh`](../scripts/gh-settings.sh). Run it yourself with `gh` logged in as the repository admin; agents never apply it.

```sh
scripts/gh-settings.sh --dry-run   # print every change, change nothing
scripts/gh-settings.sh             # apply B1 and create B2 (idempotent), then run --check
scripts/gh-settings.sh --check     # read-only; exit 1 on any drift
```

## What it sets (B1, B2)

| Item | Setting | Why |
|---|---|---|
| Branch ruleset `main` | Active, no bypass actors; PR required with **0 approvals**; code-owner review **off**; required checks `ci` and `security` (from GitHub Actions, app 15368); linear history (squash or rebase merges); no force push; no deletion | The owner is the only reviewer and merger: a required approval or code-owner review would deadlock every PR. CODEOWNERS still requests the owner's review on sensitive paths |
| Tag ruleset `legacy-v0` | Active, no bypass actors; no deletion, no update (move), no non-fast-forward | Protects the fresh-start archive (ADR-0001; closes R-001) |
| Actions permissions | Enabled; allowed actions **selected**: GitHub-owned (`actions/*`, `github/*`) plus `step-security/harden-runner@*`; SHA pinning **required** | Every `uses:` in the workflows is covered (the `--check` verifies it) |
| Fork pull requests | Workflows of every outside contributor wait for approval (`all_external_contributors`) | A public repository: no stranger's PR runs CI unreviewed |
| Default `GITHUB_TOKEN` | Read-only; Actions may not approve PRs | Least privilege |
| Secret scanning | Enabled, with push protection | Free on public repositories |
| Private vulnerability reporting | Enabled | The channel `SECURITY.md` points to |
| Dependabot alerts | Enabled | Version updates come from `.github/dependabot.yml` |
| Environment `production` (B2) | Required reviewer: the owner; deployments from `main` only; **no environment secrets** | P1b's release flow waits on it (ADR-0008) |

Rulesets are written with `PUT`, which replaces a ruleset whole. If a live ruleset holds a rule type the script does not set (say, a stricter rule you added by hand), the script stops instead of dropping it: add that rule to the script, then run it again. `--check` compares the target, enforcement, bypass actors, include and exclude patterns, every rule type, the PR parameters, the allowed merge methods, the strict status-check policy and the required checks.

## What `--check` also verifies (B3, B5)

- No repository Actions secrets and no Dependabot secrets (cosign uses GitHub OIDC; GHCR uses `GITHUB_TOKEN`; ADR-0008).
- No environment secrets in `production`.
- No deploy keys and no webhooks (nothing left from the legacy set-up).

Off GitHub, B3 also means: revoke access to the old server that the legacy `deploy/install-ubuntu.sh` set up, its database credentials and the legacy RWS API key.

## Actions variables and the contract check (P2b; set by the owner, not by the script)

The nightly workflow `contract-check.yml` (03:29 UTC since P5a, 03:23 before; GitHub may start it late; and by hand) needs two repository **variables**, not secrets:

| Variable | Value |
|---|---|
| `RWS_DOMAIN` | the domain of A2/A4, as in `/etc/rws/rws.env` on the VPS |
| `RWS_CONTACT_EMAIL` | `contact@<domain>`, as in `/etc/rws/rws.env` |

Set them under Settings → Secrets and variables → Actions → **Variables**, or with `gh variable set RWS_DOMAIN --body <domain>` and `gh variable set RWS_CONTACT_EMAIL --body contact@<domain>`. They are the public domain and contact address that every provider request carries in its User-Agent, so they are not secret. They are also readable by anyone: the runner prints each step's `env:` values in the run log, which is public on a public repository. Use the site's public role address and domain only, never a personal address. `scripts/gh-settings.sh --check` does not read variables; it still requires **0 Actions secrets** (B5). Without the variables the check exits 78 before it sends a request. No RWS API key is ever given to this workflow.

The workflow writes issues with the run's own `GITHUB_TOKEN`: its `report` job declares `issues: write` and nothing else (the top-level `permissions: {}` and B1's read-only default token stay), it has no checkout, and it runs only when the `check` job failed. Its first step is harden-runner (audit mode, pinned by SHA, as in every workflow), which, like every action in a job, can use that job's token. A report line's schema path (` at <path>`) admits domain-like text; only a compromised `check` job could plant one, and the report puts every line inside a code fence (`docs/threat-model.md` T-CI-5). It creates the label `contract-drift` itself, then opens the one issue "Contract drift: the nightly live check failed" or comments on the open one. No setting has to change for that, but an organisation policy that caps the workflow token to read-only would stop the report. After the merge, start the workflow once by hand (Actions → contract-check → Run workflow, or `gh workflow run contract-check`) and link the run in issue #17. The owner closes the issue when the drift is fixed (`docs/runbooks/schema-drift.md` §7).

## Other owner items

- **B4** (GHCR visibility) comes with P1b's first release.
- **B6**: Actions run because the repository is public (decision D7).
- Keep branch `claude/river-water-level-map-hf7bcz` until P0b merges; PR #30 is merged, so it may be deleted after that.
