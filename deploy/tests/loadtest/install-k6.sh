#!/usr/bin/env bash
# CI only (loadtest.yml): the k6 release tarball, sha256-checked (the BOM row), unpacked to <dest dir>/k6.
#   K6_VERSION=… K6_SHA256=… install-k6.sh <dest dir>
set -euo pipefail
dest=${1:?usage: install-k6.sh <dest dir>}
: "${K6_VERSION:?}" "${K6_SHA256:?}"
tgz=$dest/k6.tgz
curl --proto '=https' --tlsv1.2 -fsSL -o "$tgz" \
  "https://github.com/grafana/k6/releases/download/v${K6_VERSION}/k6-v${K6_VERSION}-linux-amd64.tar.gz"
echo "$K6_SHA256  $tgz" | sha256sum -c -
tar -xzf "$tgz" -C "$dest" --strip-components=1 --wildcards '*/k6'
"$dest/k6" version
