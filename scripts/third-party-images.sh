#!/usr/bin/env bash
# #167: the third-party images the compose files in <dir> run, one reference per line, sorted: every `image:` that is
# not one of our three release images (postgres for `db`, cloudflared for the tunnel overlay). check-bom ties each to
# its installed BOM row, digest included; a reference without a digest fails here as well, so the Grype gates
# (release.yml scan-third-party on the checkout, security.yml grype-weekly on the release's deploy bundle) scan
# exactly the image the VPS pulls.
# Usage: scripts/third-party-images.sh <dir with compose*.yaml>
set -euo pipefail

dir=${1:?usage: third-party-images.sh <dir with compose*.yaml>}
shopt -s nullglob
files=("$dir"/compose*.yaml)
((${#files[@]} > 0)) || { echo "third-party-images: no compose*.yaml in $dir" >&2; exit 1; }

all=$(sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]]+).*$/\1/p' "${files[@]}")
# This reader is line-based: an `image:` it cannot read (the value on the next line, a block scalar, a flow mapping)
# fails here instead of going unscanned. Comments are stripped before counting.
keys=$(sed 's/#.*//' "${files[@]}" | grep -c 'image:' || true)
(($(grep -c . <<<"$all" || true) == keys)) ||
  { echo "third-party-images: an image: in $dir is not of the form 'image: <ref>' on one line" >&2; exit 1; }
refs=$({ grep -vxE '\$\{RWS_(WEB|SERVER|BACKUP)_IMAGE:\?\}' <<<"$all" || true; } | sort -u)
[[ -n $refs ]] || { echo "third-party-images: no third-party image in $dir" >&2; exit 1; }
while read -r ref; do
  [[ $ref =~ ^[a-z0-9][a-z0-9./_-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$ ]] ||
    { echo "third-party-images: $ref is not pinned by tag and digest" >&2; exit 1; }
done <<<"$refs"
printf '%s\n' "$refs"
