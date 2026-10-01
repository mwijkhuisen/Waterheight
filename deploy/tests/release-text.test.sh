#!/usr/bin/env bash
# Offline test of scripts/release-text.sh, the release title and notes of `promote`
# in .github/workflows/release.yml (the owner's release-naming request). The API's
# answers are fixtures, jq is real, nothing touches the network. It also checks the
# committed template .github/release-title, so a bad edit fails CI before a release.
# Usage: deploy/tests/release-text.test.sh
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
rt=$repo/scripts/release-text.sh
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
# ok <expected stdout> <args…>: the script succeeds and prints exactly that.
ok() {
  local want=$1 got
  shift
  if got=$("$rt" "$@" 2>"$T/err"); then
    [[ $got == "$want" ]] || fail "$*: printed '$got', expected '$want'"
  else
    fail "$*: failed: $(<"$T/err")"
  fi
}
# bad <args…>: the script fails and prints nothing on stdout.
bad() {
  local got
  if got=$("$rt" "$@" 2>/dev/null); then
    fail "$*: succeeded with '$got'"
  else
    [[ -z $got ]] || fail "$*: printed '$got' before failing"
  fi
}
tpl() { printf '%s' "$1" >"$T/tpl" && echo "$T/tpl"; }

C=0123456789abcdef0123456789abcdef01234567
OTHER=fedcba9876543210fedcba9876543210fedcba98
TAG=prod-20261001T120000Z
URL=https://github.com/mwijkhuisen/Waterheight
echo '[]' >"$T/none.json"

# ---------------------------------------------------------------- pr
cat >"$T/pulls.json" <<EOF
[
  {"number": 44, "title": "[evil](https://evil.example)", "base": {"ref": "main"}, "merged_at": null, "merge_commit_sha": "$C"},
  {"number": 43, "base": {"ref": "release"}, "merged_at": "2026-10-01T10:00:00Z", "merge_commit_sha": "$C"},
  {"number": 42, "base": {"ref": "main"}, "merged_at": "2026-10-01T09:00:00Z", "merge_commit_sha": "$OTHER"},
  {"number": 45, "title": "feat: <img src=x> [click](https://evil.example)", "body": "Closes #1",
   "base": {"ref": "main"}, "merged_at": "2026-10-01T10:00:00Z", "merge_commit_sha": "$C"}
]
EOF
case_ "pr: the one PR merged into main as exactly this commit; open, other-base and other-commit PRs do not count"
ok 45 pr "$C" "$T/pulls.json"

case_ "pr: a push to main that no merged PR produced prints nothing and succeeds"
ok '' pr "$C" "$T/none.json"
ok '' pr aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$T/pulls.json"
ok 42 pr "$OTHER" "$T/pulls.json"

case_ "pr: a PR number that is not 1 to 6 digits fails"
for n in '"45a"' '"45; rm -rf /"' 45.5 1234567 0 -1 '"045"' '"4\n5"' null; do
  printf '[{"number": %s, "base": {"ref": "main"}, "merged_at": "x", "merge_commit_sha": "%s"}]' "$n" "$C" >"$T/p.json"
  bad pr "$C" "$T/p.json"
done

case_ "pr: two merged PRs for one commit, an answer that is not a list, or a bad commit fails"
printf '[{"number": 1, "base": {"ref": "main"}, "merged_at": "x", "merge_commit_sha": "%s"},
         {"number": 2, "base": {"ref": "main"}, "merged_at": "y", "merge_commit_sha": "%s"}]' "$C" "$C" >"$T/p.json"
bad pr "$C" "$T/p.json"
echo '{"message": "Not Found"}' >"$T/p.json"
bad pr "$C" "$T/p.json"
echo '{}' >"$T/p.json"
bad pr "$C" "$T/p.json"
bad pr HEAD "$T/pulls.json"
bad pr "$C" "$T/missing.json"

# ---------------------------------------------------------------- title
# release <name> <draft>: one element of GET repos/{repo}/releases.
release() { printf '{"tag_name": "prod-20260101T000000Z", "name": %s, "draft": %s}' "$1" "$2"; }
others="$(release '"v0.0.12"' false), $(release '"v1.1.0"' false), $(release '"v1.1.1"' false),
  $(release '"prod-20260930T120000Z"' false), $(release '"v10.0.3"' false), $(release '"v1.00.4"' false),
  $(release '"v1.0.x"' false), $(release null false), $(release '"x\nv1.0.99"' false), $(release '"v1.0.0"' true)"
echo "[$others]" >"$T/rel0.json"
echo "[$others, $(release '"v1.0.0"' false)]" >"$T/rel1.json"
# Two pages, as gh api --paginate writes them; two drafts above the published five.
printf '[%s, %s, %s]\n[%s, %s, %s, %s, %s]\n' \
  "$(release '"v1.0.3"' false)" "$(release '"v1.0.4"' false)" "$(release '"v1.0.6"' true)" \
  "$(release '"v1.0.0"' false)" "$(release '"v1.0.1"' false)" "$(release '"v1.0.2"' false)" \
  "$(release '"v1.0.5"' true)" "$others" >"$T/rel5.json"

case_ "title v0.0.{pr}: v0.0.<PR number>"
ok v0.0.45 title "$(tpl 'v0.0.{pr}')" 45 "$TAG" "$T/none.json"
ok v0.0.123456 title "$(tpl 'v0.0.{pr}')" 123456 "$TAG" "$T/rel5.json"

case_ "title without a merged PR: the tag, under either template"
ok "$TAG" title "$(tpl 'v0.0.{pr}')" '' "$TAG" "$T/none.json"
ok "$TAG" title "$(tpl 'v1.0.{n}')" '' "$TAG" "$T/rel5.json"

case_ "title v1.0.{n}: 0, 1 and 5 published releases of the series; other series, old tags and drafts do not count"
ok v1.0.0 title "$(tpl 'v1.0.{n}')" 45 "$TAG" "$T/rel0.json"
ok v1.0.1 title "$(tpl 'v1.0.{n}')" 45 "$TAG" "$T/rel1.json"
ok v1.0.5 title "$(tpl 'v1.0.{n}')" 45 "$TAG" "$T/rel5.json"
ok v1.1.2 title "$(tpl 'v1.1.{n}')" 45 "$TAG" "$T/rel0.json"
ok v1.0.0 title "$(tpl 'v1.0.{n}')" 45 "$TAG" "$T/none.json"

case_ "title v1.0.{n}: one more than the highest number, so a deleted release's number is never handed out again"
printf '[%s, %s, %s, %s]' "$(release '"v1.0.0"' false)" "$(release '"v1.0.2"' false)" \
  "$(release '"v1.0.09"' false)" "$(release '"v1.0.3 (hotfix)"' false)" >"$T/gap.json"
ok v1.0.10 title "$(tpl 'v1.0.{n}')" 45 "$TAG" "$T/gap.json"

case_ "title: a template that is not exactly v<a>.<b>.{pr} or v<a>.<b>.{n} on one line fails"
# shellcheck disable=SC2016 # shell syntax as literal hostile input
for t in '' 'v1.0.{x}' '1.0.{n}' 'v1.0.{n} ' $'v1.0.{n}\r\n' $'v1.0.{n}\nv2.0.{n}' $'\nv1.0.{n}' 'v1000.0.{n}' \
  'v1.0.{N}' 'v1.0.{pr}{n}' 'v1.0.{n}x' 'v1.0.' 'v1.0.45' '$(id).{n}' 'v1.0.{n}`id`'; do
  bad title "$(tpl "$t")" 45 "$TAG" "$T/rel5.json"
done
bad title "$T/no-such-template" 45 "$TAG" "$T/rel5.json"

case_ "title: a PR number that is not 1 to 6 digits fails"
# shellcheck disable=SC2016 # shell syntax as literal hostile input
for n in 45a -1 0 045 1234567 '4 5' $'45\n' ' 45' '{pr}' '$(id)'; do
  bad title "$(tpl 'v0.0.{pr}')" "$n" "$TAG" "$T/none.json"
  bad title "$(tpl 'v1.0.{n}')" "$n" "$TAG" "$T/none.json"
done

case_ "title: a bad tag, a release without a draft flag or an answer that is not a list fails"
bad title "$(tpl 'v0.0.{pr}')" '' prod-1 "$T/none.json"
bad title "$(tpl 'v0.0.{pr}')" 45 v0.0.45 "$T/none.json"
echo '[{"name": "v1.0.0"}]' >"$T/r.json"
bad title "$(tpl 'v1.0.{n}')" 45 "$TAG" "$T/r.json"
echo '[{"name": "v1.0.0", "draft": "false"}]' >"$T/r.json"
bad title "$(tpl 'v1.0.{n}')" 45 "$TAG" "$T/r.json"
echo '{"message": "Bad credentials"}' >"$T/r.json"
bad title "$(tpl 'v1.0.{n}')" 45 "$TAG" "$T/r.json"

# ---------------------------------------------------------------- notes
# closing <number> <nameWithOwner>: a closing issue as the GraphQL query of release.yml returns it.
closing() { printf '{"number": %s, "title": "[evil](https://evil.example)", "repository": {"nameWithOwner": "%s"}}' "$1" "$2"; }
issues() { printf '{"data": {"repository": {"pullRequest": {"closingIssuesReferences": {"nodes": [%s]}}}}}' "$1" >"$T/issues.json"; }

case_ "notes with a PR: links to the PR, the issues it closes in this repository and the commit; numbers and fixed text only"
issues "$(closing 7 mwijkhuisen/Waterheight), $(closing 3 MWijkhuisen/waterheight), $(closing 7 mwijkhuisen/Waterheight),
  $(closing 99 mwijkhuisen/Other), $(closing 98 evil/Waterheight)"
want="- Pull request: [#45]($URL/pull/45)
- Closes: [#3]($URL/issues/3), [#7]($URL/issues/7)
- Commit: [$C]($URL/commit/$C)

Signed production release of that commit. The VPS deploys it by its tag \`$TAG\` after verifying the signed manifest and every image (deploy/bin/rws-update)."
ok "$want" notes "$TAG" "$C" 45 "$T/issues.json"

case_ "notes with a PR that closes no issue: no Closes line"
issues ''
ok "$(grep -v '^- Closes' <<<"$want")" notes "$TAG" "$C" 45 "$T/issues.json"
issues "$(closing 99 mwijkhuisen/Other)"
ok "$(grep -v '^- Closes' <<<"$want")" notes "$TAG" "$C" 45 "$T/issues.json"

case_ "notes without a merged PR: the notes of every release before titles (the issues file is not read)"
ok "Signed production release of $C. The VPS deploys it after verifying the manifest and every image (deploy/bin/rws-update)." \
  notes "$TAG" "$C" '' "$T/no-such-file.json"

case_ "notes: an issue number that is not 1 to 6 digits, a GraphQL error, or a bad tag, commit or PR fails"
for n in '"7)"' '"7](https://evil.example)"' 7.5 0 1234567 null '"3\n4"'; do
  issues "$(closing "$n" mwijkhuisen/Waterheight)"
  bad notes "$TAG" "$C" 45 "$T/issues.json"
done
echo '{"errors": [{"message": "Resource not accessible by integration"}], "data": null}' >"$T/issues.json"
bad notes "$TAG" "$C" 45 "$T/issues.json"
issues "$(closing 7 mwijkhuisen/Waterheight)"
bad notes prod-1 "$C" 45 "$T/issues.json"
bad notes "$TAG" "${C:0:7}" 45 "$T/issues.json"
bad notes "$TAG" "$C" 45a "$T/issues.json"
bad notes "$TAG" "$C" '' # wrong argument count
bad bogus

case_ "the committed .github/release-title is valid, and release.yml reads it"
if got=$("$rt" title "$repo/.github/release-title" 45 "$TAG" "$T/rel5.json" 2>"$T/err"); then
  [[ $got =~ ^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,6}$ ]] || fail "the committed template gave '$got'"
else
  fail ".github/release-title: $(<"$T/err")"
fi
grep -qF 'scripts/release-text.sh title .github/release-title ' "$repo/.github/workflows/release.yml" ||
  fail "release.yml does not take the title from .github/release-title"

echo "$labels cases, $failures failures"
((failures == 0))
