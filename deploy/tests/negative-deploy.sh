#!/usr/bin/env bash
# [owner] Negative deploy test (issue #16 P1b; A§11.2, ADR-0008), run as root
# on the VPS once two signed releases have been deployed. It shows that:
#   1. an unsigned image is refused (Docker's official alpine, by digest);
#   2. an image signed by another identity is refused (sigstore's own cosign
#      image, keyless-signed by sigstore's release workflow, not ours);
#   3. an image of our current release verifies (the control);
#   4. an injected smoke-test failure rolls back to the release that was
#      running: rws-deploy <older> makes it current, then
#      rws-deploy --inject-smoke-failure <newer> fails and leaves <older>
#      current and active, then rws-deploy <newer> restores the newest.
# Step 4 restarts the stack three times (a few minutes of capture at most).
#
# Usage: deploy/tests/negative-deploy.sh [--dry-run] [--skip-rollback]
set -euo pipefail
# shellcheck source=deploy/bin/rws-lib.sh
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../bin/rws-lib.sh"

readonly UNSIGNED=docker.io/library/alpine@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
readonly OTHER_IDENTITY=ghcr.io/sigstore/cosign/cosign@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8
deploy=${RWS_DEPLOY:-/usr/local/bin/rws-deploy}
skip_rollback=0
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=1 ;;
    --skip-rollback) skip_rollback=1 ;;
    *)
      echo "usage: negative-deploy.sh [--dry-run] [--skip-rollback]" >&2
      exit 64
      ;;
  esac
done

newer=$(state_get current)
[[ -n $newer ]] || die "no current release: deploy one first"
older=$(find "$RWS_STATE_DIR/releases" -mindepth 1 -maxdepth 1 -type d -name 'prod-*' -printf '%f\n' |
  sort | awk -v cur="$newer" '$0 < cur' | tail -n 1)
server=$(sed -n 's/^RWS_SERVER_IMAGE=//p' "$RWS_STATE_DIR/releases/$newer/images.env")
if ((DRY_RUN)); then
  echo "would check: $UNSIGNED refused; $OTHER_IDENTITY refused; $server verified"
  echo "would roll: ${older:-<no older release yet>} -> inject a failure into $newer -> $newer"
  exit 0
fi

fails=0
check() {
  local want=$1 ref=$2 what=$3
  if "$deploy" --verify-image "$ref" >/dev/null 2>&1; then got=verified; else got=refused; fi
  if [[ $got == "$want" ]]; then echo "PASS $what: $got"; else
    echo "FAIL $what: $got, expected $want"
    fails=$((fails + 1))
  fi
}
check refused "$UNSIGNED" "an unsigned image"
check refused "$OTHER_IDENTITY" "an image signed by another identity"
check verified "$server" "the current release's server image"

if ((skip_rollback)); then
  echo "SKIP the injected smoke failure (--skip-rollback)"
elif [[ -z $older ]]; then
  echo "SKIP the injected smoke failure: it needs an older release than $newer in $RWS_STATE_DIR/releases"
  fails=$((fails + 1))
else
  "$deploy" "$older" || die "could not deploy the older release $older"
  if "$deploy" --inject-smoke-failure "$newer"; then
    echo "FAIL the injected smoke failure did not fail the deploy"
    fails=$((fails + 1))
  elif [[ $(state_get current) == "$older" && $(readlink "$RWS_STATE_DIR/active") == "releases/$older" ]]; then
    echo "PASS an injected smoke failure of $newer rolled back to $older (current and active)"
  else
    echo "FAIL after the injected failure: current $(state_get current), active $(readlink "$RWS_STATE_DIR/active")"
    fails=$((fails + 1))
  fi
  "$deploy" "$newer" || die "could not restore $newer: run rws-deploy $newer"
  echo "restored $newer"
fi
((fails == 0))
