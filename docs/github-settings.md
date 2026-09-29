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
| Default `GITHUB_TOKEN` | Read-only; Actions may not approve PRs | Least privilege |
| Secret scanning | Enabled, with push protection | Free on public repositories |
| Private vulnerability reporting | Enabled | The channel `SECURITY.md` points to |
| Dependabot alerts | Enabled | Version updates come from `.github/dependabot.yml` |
| Environment `production` (B2) | Required reviewer: the owner; deployments from `main` only; **no environment secrets** | P1b's release flow waits on it (ADR-0008) |

## What `--check` also verifies (B3, B5)

- No repository Actions secrets and no Dependabot secrets (cosign uses GitHub OIDC; GHCR uses `GITHUB_TOKEN`; ADR-0008).
- No environment secrets in `production`.
- No deploy keys and no webhooks (nothing left from the legacy set-up).

Off GitHub, B3 also means: revoke access to the old server that the legacy `deploy/install-ubuntu.sh` set up, its database credentials and the legacy RWS API key.

## Other owner items

- **B4** (GHCR visibility) comes with P1b's first release.
- **B6**: Actions run because the repository is public (decision D7).
- Keep branch `claude/river-water-level-map-hf7bcz` until P0b merges; PR #30 is merged, so it may be deleted after that.
