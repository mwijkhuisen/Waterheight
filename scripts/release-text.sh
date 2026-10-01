#!/usr/bin/env bash
# The title and notes of a production release (`promote` in .github/workflows/release.yml).
# They are cosmetic: the VPS and every runbook know a release only by its tag
# prod-<UTC timestamp> and its signed manifest (deploy/bin/rws-lib.sh). The job fetches
# the JSON with gh; this script only reads files, so it runs offline
# (deploy/tests/release-text.test.sh). Its output is numbers and fixed text only, never
# a PR title or body or any other text from the API (no markdown or link injection).
#
#   scripts/release-text.sh pr <commit> <pulls.json>
#       The number of the PR merged into main as exactly <commit>, or nothing.
#       pulls.json: GET repos/{repo}/commits/{commit}/pulls
#   scripts/release-text.sh title <template file> <pr|''> <tag> <releases.json>
#       The template (.github/release-title) is v<a>.<b>.{pr} or v<a>.<b>.{n}: {pr} is the
#       PR number; {n} is one more than the highest <number> of a published release titled
#       v<a>.<b>.<number> (the first is .0; drafts do not count, nor does a gap close).
#       Without a PR, the title is the tag. releases.json: GET repos/{repo}/releases, all pages.
#   scripts/release-text.sh notes <tag> <commit> <pr|''> <issues.json>
#       Markdown. issues.json: the GraphQL closingIssuesReferences of the PR (read only
#       when there is one).
set -euo pipefail
export LC_ALL=C

readonly REPO_URL=https://github.com/mwijkhuisen/Waterheight
readonly TAG_RE='^prod-[0-9]{8}T[0-9]{6}Z$'
readonly TEMPLATE_RE='^(v[0-9]{1,3}\.[0-9]{1,3}\.)\{(pr|n)\}$'

die() {
  echo "release-text: $*" >&2
  exit 1
}
usage() {
  echo "usage: $0 pr <commit> <pulls.json> | title <template file> <pr|''> <tag> <releases.json> | notes <tag> <commit> <pr|''> <issues.json>" >&2
  exit 2
}
# Never echo the value: it comes from the API.
num() { [[ $1 =~ ^[1-9][0-9]{0,5}$ ]] || die "$2 is not a number of 1 to 6 digits"; }
commit_ok() { [[ $1 =~ ^[0-9a-f]{40}$ ]] || die "not a commit sha"; }
tag_ok() { [[ $1 =~ $TAG_RE ]] || die "not a release tag"; }

case ${1:-} in
  pr)
    (($# == 3)) || usage
    commit_ok "$2"
    prs=$(jq -r --arg c "$2" '
      if type == "array" then .[] else error("not a list of pull requests") end
      | select(.base.ref == "main" and .merged_at != null and .merge_commit_sha == $c)
      | .number | if type == "number" then tostring else error("a PR number that is no number") end' "$3")
    [[ -n $prs ]] || exit 0 # a push to main that no merged PR produced
    [[ $prs != *$'\n'* ]] || die "more than one merged PR for one commit"
    num "$prs" "the PR number"
    echo "$prs"
    ;;
  title)
    (($# == 5)) || usage
    [[ -f $2 ]] || die "no template file"
    tpl=$(<"$2")
    [[ $tpl =~ $TEMPLATE_RE ]] || die "the template must be v<a>.<b>.{pr} or v<a>.<b>.{n}, one line"
    prefix=${BASH_REMATCH[1]} kind=${BASH_REMATCH[2]}
    pr=$3 tag=$4
    tag_ok "$tag"
    if [[ -z $pr ]]; then
      echo "$tag"
      exit 0
    fi
    num "$pr" "the PR number"
    if [[ $kind == pr ]]; then
      echo "$prefix$pr"
      exit 0
    fi
    # One line per published release title; a line break in a title becomes a space.
    titles=$(jq -r '
      if type == "array" then .[] else error("not a list of releases") end
      | if (.draft | type) != "boolean" then error("a release without a draft flag")
        elif .draft then empty
        else .name // "" | gsub("[\r\n]"; " ") end' "$5")
    next=0
    while IFS= read -r t; do
      [[ $t == "$prefix"* && ${t#"$prefix"} =~ ^([0-9]{1,6})([^0-9]|$) ]] || continue
      ((10#${BASH_REMATCH[1]} < next)) || next=$((10#${BASH_REMATCH[1]} + 1))
    done <<<"$titles"
    echo "$prefix$next"
    ;;
  notes)
    (($# == 5)) || usage
    tag=$2 commit=$3 pr=$4
    tag_ok "$tag"
    commit_ok "$commit"
    if [[ -z $pr ]]; then
      # The notes of every release before titles existed.
      echo "Signed production release of $commit. The VPS deploys it after verifying the manifest and every image (deploy/bin/rws-update)."
      exit 0
    fi
    num "$pr" "the PR number"
    found=$(jq -r '
      .data.repository.pullRequest.closingIssuesReferences.nodes
      | if type == "array" then .[] else error("no closingIssuesReferences") end
      | select(.repository.nameWithOwner | ascii_downcase == "mwijkhuisen/waterheight")
      | .number | if type == "number" then tostring else error("an issue number that is no number") end' "$5")
    links=''
    if [[ -n $found ]]; then
      while IFS= read -r i; do num "$i" "an issue number"; done <<<"$found"
      while IFS= read -r i; do links+="${links:+, }[#$i]($REPO_URL/issues/$i)"; done < <(sort -nu <<<"$found")
    fi
    echo "- Pull request: [#$pr]($REPO_URL/pull/$pr)"
    [[ -z $links ]] || echo "- Closes: $links"
    echo "- Commit: [$commit]($REPO_URL/commit/$commit)"
    echo
    echo "Signed production release of that commit. The VPS deploys it by its tag \`$tag\` after verifying the signed manifest and every image (deploy/bin/rws-update)."
    ;;
  *) usage ;;
esac
