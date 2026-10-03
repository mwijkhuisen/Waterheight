#!/usr/bin/env bash
# River-network tiles (P6b): tippecanoe in the tool image, no network, fixed in-container paths so that the
# generator_options tippecanoe records in the PMTiles metadata never hold a host path.
#   tiles.sh build  <in.geojsonseq> <rivers-YYYYMMDD.pmtiles>
#   tiles.sh decode <in.pmtiles>    <out.json>      (tippecanoe-decode writes GeoJSON to stdout)
# RWS_GEO_IMAGE, default rws-geo-tools:local. Exit 64 on usage.
set -euo pipefail

(($# == 3)) || { echo "usage: tiles.sh build|decode <in> <out>" >&2; exit 64; }
mode=$1
image=${RWS_GEO_IMAGE:-rws-geo-tools:local}
in=$2
out=$3
[[ -f $in ]] || { echo "tiles: no such input" >&2; exit 64; }
indir=$(cd "$(dirname "$in")" && pwd)
inname=$(basename "$in")
outdir=$(cd "$(dirname "$out")" && pwd)
outname=$(basename "$out")

tool() {
  docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp \
    -u "$(id -u):$(id -g)" "$@"
}

case $mode in
  build)
    [[ $outname =~ ^rivers-[0-9]{8}\.pmtiles$ ]] || { echo "tiles: bad output name" >&2; exit 64; }
    tool -v "$indir:/work/in:ro" -v "$outdir:/work/out" "$image" tippecanoe \
      -o "/work/out/$outname" --force --temporary-directory=/tmp --quiet \
      -l rivers -Z0 -z12 -n "${outname%.pmtiles}" \
      -A "© OpenStreetMap contributors" -N "River network derived from OpenStreetMap, ODbL 1.0" \
      "/work/in/$inname"
    ;;
  decode)
    [[ $inname =~ ^[A-Za-z0-9._-]+\.pmtiles$ ]] || { echo "tiles: bad input name" >&2; exit 64; }
    tool -v "$indir:/work/in:ro" "$image" tippecanoe-decode "/work/in/$inname" >"$outdir/$outname"
    ;;
  *)
    echo "usage: tiles.sh build|decode <in> <out>" >&2
    exit 64
    ;;
esac
