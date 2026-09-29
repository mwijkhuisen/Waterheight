#!/usr/bin/env bash
# Fresh-start guard (ADR-0001): fail if a tree reuses anything from legacy-v0.
#
# Usage: scripts/verify-fresh-start.sh [tree-ish]   (default: HEAD)
#
# Checks, in order. Each one fails closed, so the script never passes vacuously:
#   1. The repository is not shallow: a cut history hides legacy blobs.
#   2. refs/tags/legacy-v0 exists and peels to LEGACY_COMMIT. Until the tag
#      ruleset exists, anyone with write access can move the tag, and a moved
#      tag must fail instead of turning the blob check into a no-op.
#   3. Every object reachable from LEGACY_COMMIT is present locally (not a
#      partial clone), and its blobs are exactly the pinned set
#      (LEGACY_BLOBS_DIGEST). Grafts, replace refs or anything else that cuts
#      the history must fail instead of quietly shrinking check 4.
#   4. No blob in the tree has the SHA of any legacy blob (the whole history,
#      not only the tip), unless that exact "<blob-sha> <path>" pair is in
#      scripts/fresh-start-allowlist.txt.
#   5. No legacy-only path (LEGACY_ONLY below) and no submodule exists in the
#      tree: a gitlink could point at the legacy commit itself.
#
# Legacy-only paths have no place in the new layout (docs/plan/ARCHITECTURE.md
# §5). The new layout reuses other legacy paths: README.md, .gitignore,
# package.json, tsconfig*.json, .env.example, .dockerignore, Dockerfile,
# .github/workflows/ci.yml, docs/ and deploy/. Those are not denied by path:
# they may return with new content only, and check 4 catches old content.
#
# Allowlist: one "<40-hex blob sha> <path> # <reason>" per line; the path has
# no whitespace. Blank lines and lines starting with "#" are ignored. There are
# no globs, and a missing file allows nothing. Its only use: check 4 covers the
# whole legacy history, so a tiny new file (a one-line placeholder) can match
# an old blob by chance. An entry must name a legacy blob of at most
# MAX_ALLOW_BYTES; anything else, a malformed line or a symlinked file is fatal.
#
# Exit codes:
#   0   clean
#   2   usage error
#   3   tag legacy-v0 missing
#   4   legacy-v0 does not peel to LEGACY_COMMIT
#   5   shallow repository
#   6   the argument is not a tree-ish
#   7   bad allowlist (malformed line, not a small legacy blob, or a symlink)
#   8   the legacy blob set is not the pinned one (history cut or altered)
#   9   legacy objects missing locally (partial clone)
#   10  legacy blob(s) in the tree
#   11  legacy-only path(s) or submodule(s) in the tree
#   12  both 10 and 11
#   any other non-zero: a git command failed (set -e stops there)
set -euo pipefail

readonly LEGACY_COMMIT=a4106b855c782832d7695a5dfcbbb67adf87be0c
# git hash-object of the sorted list of blob SHAs reachable from LEGACY_COMMIT.
readonly LEGACY_BLOBS_DIGEST=8f61610efe3b3903dc39eb0289fb1db9f0909443
readonly MAX_ALLOW_BYTES=256
readonly LEGACY_ONLY=(
  packages/server packages/shared packages/web spike fixtures
  PROMPT.md docker-compose.yml package-lock.json
  deploy/install-ubuntu.sh deploy/rws-api.service deploy/rws-backfill.service
  docs/INSTALL-UBUNTU.md docs/INTERNATIONAL-DATA.md docs/PROMPT-PHASE3-GERMANY.md
)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Local replace refs or grafts must not swap the legacy history for something
# harmless; check 3 catches any other way. The graft file lives in our fresh
# temp dir, so it cannot exist (/dev/null would trigger git's grafts advice).
export GIT_NO_REPLACE_OBJECTS=1
export GIT_GRAFT_FILE=$tmp/grafts

die() {
  local code=$1
  shift
  printf 'verify-fresh-start: %s\n' "$*" >&2
  exit "$code"
}

(($# <= 1)) || die 2 "usage: $0 [tree-ish]"
target=${1:-HEAD}
[[ -n $target && $target != -* ]] || die 2 "usage: $0 [tree-ish]"

shallow=$(git rev-parse --is-shallow-repository)
[[ $shallow == false ]] || die 5 "shallow repository; run: git fetch --unshallow"

git rev-parse --verify --quiet refs/tags/legacy-v0 >/dev/null ||
  die 3 "tag legacy-v0 not found; run: git fetch origin tag legacy-v0"
legacy=$(git rev-parse --verify --quiet 'refs/tags/legacy-v0^{commit}') || legacy='(not a commit)'
[[ $legacy == "$LEGACY_COMMIT" ]] ||
  die 4 "legacy-v0 points to $legacy, expected $LEGACY_COMMIT"

tree=$(git rev-parse --verify --quiet "$target^{tree}") || die 6 "not a tree-ish: $target"

declare -A legacy_blob=() allowed=()

# --missing=print marks absent objects with "?" instead of fetching them.
objects=$(git rev-list --objects --no-object-names --missing=print "$LEGACY_COMMIT")
[[ $objects != *'?'* ]] ||
  die 9 "legacy objects missing locally (partial clone?); use a full clone"
blobs=$(git cat-file --batch-check='%(objecttype) %(objectname)' <<<"$objects" |
  awk '$2 == "missing" { exit 1 } $1 == "blob" { print $2 }' | LC_ALL=C sort)
digest=$(git hash-object --stdin <<<"$blobs")
[[ $digest == "$LEGACY_BLOBS_DIGEST" ]] ||
  die 8 "legacy blob set is not the pinned one (history cut or altered?)"
while read -r sha; do legacy_blob[$sha]=1; done <<<"$blobs"

allowlist=$(git rev-parse --show-toplevel)/scripts/fresh-start-allowlist.txt
[[ ! -L $allowlist ]] || die 7 "$allowlist must not be a symlink"
if [[ -f $allowlist ]]; then
  re='^([0-9a-f]{40}) ([^[:space:]]+) # .*[^[:space:]]'
  n=0
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    if [[ -z ${line//[[:space:]]/} || $line == '#'* ]]; then continue; fi
    [[ $line =~ $re ]] || die 7 "$allowlist:$n: expected '<blob-sha> <path> # <reason>'"
    sha=${BASH_REMATCH[1]} path=${BASH_REMATCH[2]}
    [[ -n ${legacy_blob[$sha]:-} ]] || die 7 "$allowlist:$n: $sha is not a legacy blob"
    size=$(git cat-file -s "$sha")
    ((size <= MAX_ALLOW_BYTES)) ||
      die 7 "$allowlist:$n: $size-byte blob; only blobs up to $MAX_ALLOW_BYTES bytes may be allowlisted"
    allowed["$sha $path"]=1
  done <"$allowlist"
fi

# A file, not process substitution: a failing ls-tree must stop the script.
git ls-tree -r -z --full-tree "$tree" >"$tmp/listing"

found_blob=0 found_path=0
while IFS= read -r -d '' entry; do
  path=${entry#*$'\t'}
  read -r _ type sha <<<"${entry%%$'\t'*}"
  if [[ $type == blob && -n ${legacy_blob[$sha]:-} && -z ${allowed["$sha $path"]:-} ]]; then
    printf 'legacy blob: %s %q\n' "$sha" "$path"
    found_blob=1
  fi
  if [[ $type == commit ]]; then
    printf 'submodule: %q -> %s\n' "$path" "$sha"
    found_path=1
  fi
  for p in "${LEGACY_ONLY[@]}"; do
    if [[ $path == "$p" || $path == "$p"/* ]]; then
      printf 'legacy-only path: %q (%s %s)\n' "$path" "$type" "$sha"
      found_path=1
    fi
  done
done <"$tmp/listing"

if ((found_blob && found_path)); then die 12 "legacy blobs and legacy-only paths or submodules in $target"; fi
if ((found_blob)); then die 10 "legacy blobs in $target"; fi
if ((found_path)); then die 11 "legacy-only paths or submodules in $target"; fi
echo "verify-fresh-start: OK, $target ($tree) holds no legacy blob, legacy-only path or submodule"
