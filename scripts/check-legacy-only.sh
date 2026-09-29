#!/usr/bin/env bash
# Keeps verify-fresh-start.sh's LEGACY_ONLY list in sync with legacy-v0
# (P0a code review F4). Paths only: it never reads legacy file content.
#   1. every LEGACY_ONLY entry exists in legacy-v0 (as a file or a directory);
#   2. every legacy path is covered by LEGACY_ONLY or by a path the new layout
#      reuses (the list in verify-fresh-start.sh's header, blob-checked there).
# Usage: scripts/check-legacy-only.sh   (needs the legacy-v0 tag locally)
set -euo pipefail

here=$(dirname "$0")
guard=$here/verify-fresh-start.sh

# The array literal between "readonly LEGACY_ONLY=(" and ")".
mapfile -t legacy_only < <(sed -n '/^readonly LEGACY_ONLY=(/,/^)/{/^readonly\|^)/d;p}' "$guard" | tr -s ' ' '\n' | sed '/^$/d')
((${#legacy_only[@]} > 0)) || { echo "check-legacy-only: could not read LEGACY_ONLY from $guard" >&2; exit 1; }

# Reused by the new layout (ARCHITECTURE §5); the blob check guards their content.
reused=(README.md .gitignore package.json tsconfig.json tsconfig.base.json .env.example .dockerignore
  Dockerfile .github/workflows/ci.yml docs deploy packages)

git rev-parse --verify --quiet 'refs/tags/legacy-v0^{commit}' >/dev/null ||
  { echo "check-legacy-only: tag legacy-v0 missing" >&2; exit 1; }
paths=$(mktemp)
trap 'rm -f "$paths"' EXIT
# A file, not a pipeline into the loop: a failing ls-tree must stop the script.
git ls-tree -r --name-only -z 'legacy-v0^{commit}' >"$paths.z"
tr '\0' '\n' <"$paths.z" >"$paths"
rm -f "$paths.z"

covered() {
  local path=$1 p
  for p in "${legacy_only[@]}" "${reused[@]}"; do
    [[ $path == "$p" || $path == "$p"/* ]] && return 0
  done
  return 1
}

fail=0
for p in "${legacy_only[@]}"; do
  if ! grep -qxF -- "$p" "$paths" && ! grep -q -- "^$p/" "$paths"; then
    echo "check-legacy-only: LEGACY_ONLY entry $p is not a path in legacy-v0" >&2
    fail=1
  fi
done
while IFS= read -r path; do
  if ! covered "$path"; then
    echo "check-legacy-only: legacy path $path is neither legacy-only nor a reused path" >&2
    fail=1
  fi
done <"$paths"
((fail == 0)) || exit 1
echo "check-legacy-only: OK, ${#legacy_only[@]} legacy-only entries match legacy-v0 ($(wc -l <"$paths") paths)"
