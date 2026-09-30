#!/usr/bin/env bash
# Workflow greps (issue #15 security.yml), next to zizmor:
#   - every `uses:` names an action at a 40-hex commit SHA plus a "# vX.Y.Z" comment;
#   - every workflow has top-level `permissions: {}`;
#   - no pull_request_target, workflow_run or issue_comment trigger;
#   - no actions/cache, no setup-node `cache:` input, no buildx cache-from/cache-to, and
#     package-manager-cache: false on every setup-node (a PR run must never seed a main run);
#   - every actions/checkout sets persist-credentials: false.
# Usage: scripts/check-workflows.sh [workflow-dir]   (default .github/workflows)
set -euo pipefail

dir=${1:-.github/workflows}
shopt -s nullglob
files=("$dir"/*.yml "$dir"/*.yaml)
((${#files[@]} > 0)) || { echo "check-workflows: no workflow in $dir" >&2; exit 1; }

fail=0
bad() { echo "check-workflows: $*" >&2; fail=1; }

for f in "${files[@]}"; do
  grep -qxF 'permissions: {}' "$f" || bad "$f: no top-level 'permissions: {}'"
  while IFS= read -r line; do
    [[ $line =~ uses:\ [A-Za-z0-9._-]+/[A-Za-z0-9._/-]+@[0-9a-f]{40}\ \#\ v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
      bad "$f: not pinned to a SHA with a version comment: ${line#"${line%%[![:space:]]*}"}"
  done < <(grep -E '^[[:space:]]*(-[[:space:]]+)?uses:' "$f" || true)
  # Anywhere outside a comment: block style, flow style (on: [pull_request_target]) or inline.
  if grep -nE '^[^#]*\b(pull_request_target|workflow_run|issue_comment)\b' "$f"; then
    bad "$f: forbidden trigger"
  fi
  if grep -nE 'uses:[[:space:]]*actions/cache[@/]|^[[:space:]]+cache(-from|-to)?:[[:space:]]' "$f"; then
    bad "$f: caches are not allowed"
  fi
  setup_nodes=$(grep -cE 'uses:[[:space:]]*actions/setup-node@' "$f" || true)
  no_cache=$(grep -cE '^[[:space:]]+package-manager-cache:[[:space:]]*false[[:space:]]*$' "$f" || true)
  ((setup_nodes == no_cache)) || bad "$f: $setup_nodes setup-node step(s) but $no_cache package-manager-cache: false"
  checkouts=$(grep -cE 'uses:[[:space:]]*actions/checkout@' "$f" || true)
  no_persist=$(grep -cE '^[[:space:]]+persist-credentials:[[:space:]]*false[[:space:]]*$' "$f" || true)
  ((checkouts == no_persist)) || bad "$f: $checkouts checkout(s) but $no_persist persist-credentials: false"
done

((fail == 0)) || exit 1
echo "check-workflows: OK (${#files[@]} workflows)"
