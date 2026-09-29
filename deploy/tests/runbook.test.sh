#!/usr/bin/env bash
# Offline test of the first-install block of docs/runbooks/bootstrap.md against
# the release manifest that .github/workflows/release.yml writes (issue #16
# P1b; R-031). Both are read from the files, so they cannot drift: the jq
# program of the promote job builds a manifest, and the runbook's `sha=` and
# `tag=` lines (step 1, and step 5 through sudo) must extract the bundle hash
# and the tag from it, compact as released and pretty-printed as well.
# Usage: deploy/tests/runbook.test.sh
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
failures=0 labels=0
fail() {
  echo "  FAIL: $*" >&2
  failures=$((failures + 1))
}
case_() {
  labels=$((labels + 1))
  printf 'case %s\n' "$*"
}

# The promote job's jq command, from `jq -cn --arg tag` to its redirect.
program=$(sed -n '/^ *jq -c\{0,1\}n --arg tag /,/>"[$]out\/release-manifest\.json"$/p' "$repo/.github/workflows/release.yml")
# The runbook's extraction lines; step 5 reads the manifest from /root as ops, through sudo.
lines=$(grep -E '^(sha|tag)=\$\((sudo )?grep ' "$repo/docs/runbooks/bootstrap.md")

case_ "release.yml builds a one-line manifest; the runbook has the sha and tag lines of steps 1 and 5"
[[ -n $program ]] || fail "no jq command in release.yml"
[[ $(grep -c '^sha=' <<<"$lines") == 1 && $(grep -c '^tag=' <<<"$lines") == 2 ]] ||
  fail "expected one sha= and two tag= lines in bootstrap.md, got: $lines"
out=$T/out
mkdir -p "$out"
head -c 1000 /dev/urandom >"$out/deploy-bundle.tar.gz"
want_sha=$(sha256sum "$out/deploy-bundle.tar.gz" | cut -d' ' -f1)
want_tag=prod-20261001T120000Z
d() { printf 'sha256:%s' "$(printf '%s' "$1" | sha256sum | cut -d' ' -f1)"; }
(
  # shellcheck disable=SC2034 # read by the eval'd jq command of release.yml
  tag=$want_tag COMMIT=$(printf 'c%.0s' {1..40}) SERVER=$(d s) WEB=$(d w) BACKUP=$(d b)
  eval "$program"
) || fail "the jq command of release.yml failed"
[[ $(wc -l <"$out/release-manifest.json") == 1 ]] || fail "the manifest is not compact"
jq . "$out/release-manifest.json" >"$T/pretty.json"

for form in compact pretty; do
  case_ "the runbook extracts the bundle sha256 and the tag from the $form manifest"
  dir=$T/$form
  mkdir -p "$dir/root/rws-release"
  if [[ $form == compact ]]; then cp "$out/release-manifest.json" "$dir/root/rws-release/"; else
    cp "$T/pretty.json" "$dir/root/rws-release/release-manifest.json"
  fi
  (
    cd "$dir/root/rws-release"
    # shellcheck disable=SC2329 # called by the eval'd step-5 line
    sudo() { "$@"; }
    while IFS= read -r line; do
      sha='' tag=''
      eval "${line//\/root\/rws-release\//$dir/root/rws-release/}"
      case $line in
        sha=*) [[ $sha == "$want_sha" ]] || { echo "  FAIL: $form: sha '$sha', expected $want_sha" >&2; exit 1; } ;;
        tag=*) [[ $tag == "$want_tag" ]] || { echo "  FAIL: $form: tag '$tag', expected $want_tag" >&2; exit 1; } ;;
      esac
    done <<<"$lines"
  ) || failures=$((failures + 1))
done

echo "$labels cases, $failures failures"
((failures == 0))
