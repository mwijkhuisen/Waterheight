#!/usr/bin/env bash
# The statistics script of an Umami release (#270 B, ADR-0024; docs/runbooks/stats.md §9): /app/public/script.js of
# every linux platform of a pinned ghcr.io/umami-software/umami index, read from the registry without a Docker daemon.
# The index, each manifest and each layer must hash to the digest that names it; the topmost layer holding the file is
# what the image serves. Prints each platform's sha256 and size, fails unless all platforms agree, and with an out file
# writes the bytes there (apps/web/public/assets/stats-<first 8 hex>.js, the BOM row `umami tracker`).
# Usage: scripts/umami-tracker.sh ghcr.io/umami-software/umami:<tag>@sha256:<index digest> [out file]
# Exit 0 = one script for all platforms, 1 = a mismatch or no script, 64 = usage.
set -euo pipefail

ref=${1:-} out=${2:-}
if [[ ! $ref =~ ^ghcr\.io/(umami-software/umami):[^@/]+@(sha256:[0-9a-f]{64})$ ]]; then
  echo 'usage: scripts/umami-tracker.sh ghcr.io/umami-software/umami:<tag>@sha256:<64 hex> [out file]' >&2
  exit 64
fi
repo=${BASH_REMATCH[1]} digest=${BASH_REMATCH[2]}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

json() { python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); $1" "$2"; }
token=$(curl -fsSL "https://ghcr.io/token?scope=repository:$repo:pull&service=ghcr.io" -o "$tmp/token.json" &&
  json 'print(d["token"])' "$tmp/token.json")
accept='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
# get <manifests|blobs> <digest> <file>: download and check that the bytes hash to the digest.
get() {
  curl -fsSL -H "Authorization: Bearer $token" -H "Accept: $accept" -o "$3" "https://ghcr.io/v2/$repo/$1/$2"
  if [ "sha256:$(sha256sum <"$3" | cut -d' ' -f1)" != "$2" ]; then
    echo "umami-tracker: $1/$2 does not hash to its digest" >&2
    exit 1
  fi
}

get manifests "$digest" "$tmp/index.json"
platforms=$(json 'print(" ".join(m["digest"]+"/"+m["platform"]["architecture"] for m in d["manifests"] if m.get("platform",{}).get("os")=="linux"))' "$tmp/index.json")
[ -n "$platforms" ] || { echo 'umami-tracker: no linux platform in the index' >&2; exit 1; }
for p in $platforms; do
  arch=${p#*/}
  get manifests "${p%/*}" "$tmp/manifest.json"
  for layer in $(json 'print(" ".join(l["digest"] for l in d["layers"]))' "$tmp/manifest.json"); do
    get blobs "$layer" "$tmp/layer"
    # GNU tar detects the layer's compression itself; a layer without the file is skipped.
    if tar -xOf "$tmp/layer" app/public/script.js >"$tmp/found" 2>/dev/null && [ -s "$tmp/found" ]; then
      mv "$tmp/found" "$tmp/script-$arch.js"
    fi
  done
  [ -s "$tmp/script-$arch.js" ] || { echo "umami-tracker: $arch has no /app/public/script.js" >&2; exit 1; }
  echo "$arch $(sha256sum <"$tmp/script-$arch.js" | cut -d' ' -f1) $(wc -c <"$tmp/script-$arch.js") bytes"
done
scripts=("$tmp"/script-*.js)
if [ "$(sha256sum "${scripts[@]}" | cut -d' ' -f1 | sort -u | wc -l)" -ne 1 ]; then
  echo 'umami-tracker: the platforms ship different scripts' >&2
  exit 1
fi
if [ -n "$out" ]; then
  cp "${scripts[0]}" "$out"
  echo "wrote $out"
fi
