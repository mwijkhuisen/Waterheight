#!/usr/bin/env bash
# CI only (P12a, issue #27; called by deploy/tests/e2e/run.sh in RWS_E2E_MODE=drill, as root, before migrate):
# writes the flood drill's registry, <outdir>/registry, a copy of <repo>/registry with the one change of
# registry-patch (station 2020 of CH-1, Ticino, outside the basin, becomes a test-only drill station: its discharge
# series is public). compose.drill.yaml bind-mounts the copy over /app/registry of the services that read the registry
# of the database or the publishers. registry/ itself is never touched, and the patch is applied with no fuzz: when
# registry/stations/ch-1.yaml has changed so that it no longer applies, this fails.
# Usage: deploy/tests/flood/setup.sh <outdir> <repo>
set -euo pipefail

fail() {
  echo "flood/setup.sh: $*" >&2
  exit 1
}

(($# == 2)) || {
  echo "usage: deploy/tests/flood/setup.sh <outdir> <repo>" >&2
  exit 64
}
out=$1
repo=$2
here=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
[[ -d $repo/registry ]] || fail "$repo/registry is not a directory"
[[ -f $here/registry-patch ]] || fail "registry-patch is missing"

rm -rf "${out:?}/registry"
mkdir -p "$out"
cp -a "$repo/registry" "$out/registry"
patch -p1 -F0 --no-backup-if-mismatch -s -d "$out/registry" -i "$here/registry-patch" ||
  fail "registry-patch no longer applies to registry/ (regenerate it against registry/stations/ch-1.yaml)"

# Exactly one file differs from registry/, and in it station 2020's discharge series is public.
changed=$(diff -rq "$repo/registry" "$out/registry" || true)
[[ $(wc -l <<<"$changed") == 1 && $changed == *"stations/ch-1.yaml"* ]] ||
  fail "the patched registry differs from registry/ in more than stations/ch-1.yaml"
audience=$(awk '/provider_key: 2020\/Q$/ { f = 1 } f && /^    audience:/ { print $2; exit }' "$out/registry/stations/ch-1.yaml")
[[ $audience == public ]] || fail "station 2020's discharge series is not public after the patch"
[[ $(awk '/provider_key: 2020\/W$/ { f = 1 } f && /^    audience:/ { print $2; exit }' "$out/registry/stations/ch-1.yaml") == '"off"' ]] ||
  fail "station 2020's water-level series is not off after the patch"
chmod -R a+rX "$out"
echo "flood/setup.sh: $out/registry written (station 2020: Q public, W off)"
