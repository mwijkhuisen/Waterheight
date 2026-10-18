#!/usr/bin/env bash
# Lint of the runbooks that P12b (issue #27) added or changed. Each one needs a
# **Trigger:** line, a numbered "## N." section and a bash fence, and every
# rws-* command, deploy/ path and scripts/ path it names must exist in the
# repository. A fixed list: older runbooks are not held to this.
# Usage: deploy/tests/runbooks-lint.test.sh
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
runbooks=(tide provider-outage dst-check token-rotation vps-rebuild basemap brownout schema-drift disk-full edge-switch domain-change cutover-waterradar-tunnel climatology travel-times)
failures=0
fail() {
  echo "  FAIL: $*" >&2
  failures=$((failures + 1))
}

for name in "${runbooks[@]}"; do
  f=$repo/docs/runbooks/$name.md
  echo "case $name"
  if [[ ! -f $f ]]; then
    fail "$name.md does not exist"
    continue
  fi
  grep -q '^\*\*Trigger:\*\*' "$f" || fail "$name.md: no **Trigger:** line"
  grep -qE '^## [0-9]+\. ' "$f" || fail "$name.md: no numbered '## N.' section"
  grep -qE '^ *```bash' "$f" || fail "$name.md: no bash fence"

  # rws-* names: a command in deploy/bin or a unit in deploy/systemd. Container names (rws-db-1) and
  # the ad-hoc unit of the basemap runbook's systemd-run example and its lock name, the db_postgres
  # secret's group, the tunnel token's group and the release directory are not files; rws-lib is the sourced rws-lib.sh.
  while IFS= read -r t; do
    [[ $t =~ -[0-9]+$ || $t == rws-basemap-manual || $t == rws-basemap || $t == rws-dbpostgres || $t == rws-cftunnel || $t == rws-release ]] && continue
    [[ -e $repo/deploy/bin/$t || -e $repo/deploy/bin/$t.sh ]] ||
      compgen -G "$repo/deploy/systemd/$t.*" >/dev/null ||
      fail "$name.md: '$t' is neither deploy/bin/$t nor a unit under deploy/systemd"
  done < <(grep -oE '\brws-[a-z][a-z0-9-]*[a-z0-9]' "$f" | sort -u)

  # deploy/ and scripts/ paths (a glob or a placeholder ends the match; the directory must exist).
  while IFS= read -r p; do
    [[ -e $repo/$p ]] || fail "$name.md: '$p' does not exist"
  done < <(grep -oE '\b(deploy|scripts)/[A-Za-z0-9_./-]*[A-Za-z0-9_]' "$f" | sort -u)
done

if ((failures > 0)); then
  echo "$failures failure(s)" >&2
  exit 1
fi
echo "ok: ${#runbooks[@]} runbooks"
