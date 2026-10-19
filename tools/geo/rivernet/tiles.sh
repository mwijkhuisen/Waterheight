#!/usr/bin/env bash
# River-network tiles (P6b): tippecanoe in the tool image, no network, fixed in-container paths so that the
# generator_options tippecanoe records in the PMTiles metadata never hold a host path.
#   tiles.sh build  <rivers-YYYYMMDD.pmtiles> <layer>:<in.geojsonseq> [<layer>:<in.geojsonseq> …]
#   tiles.sh decode <in.pmtiles> <out.json>      (tippecanoe-decode writes GeoJSON to stdout)
# A layer is one of rivers, reach_bins (#112: the reach position bins), waterbodies and canals (P17b), each at most
# once; every input sits in one directory, mounted read-only. RWS_GEO_IMAGE, default rws-geo-tools:local. Exit 64 on
# usage.
set -euo pipefail

usage() { echo "usage: tiles.sh build <out.pmtiles> <layer>:<in> [<layer>:<in> …] | decode <in.pmtiles> <out.json>" >&2; exit 64; }
(($# >= 3)) || usage
mode=$1
image=${RWS_GEO_IMAGE:-rws-geo-tools:local}

tool() {
  docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp \
    -u "$(id -u):$(id -g)" "$@"
}

case $mode in
  build)
    out=$2
    outdir=$(cd "$(dirname "$out")" && pwd)
    outname=$(basename "$out")
    [[ $outname =~ ^rivers-[0-9]{8}\.pmtiles$ ]] || { echo "tiles: bad output name" >&2; exit 64; }
    indir=
    layers=()
    seen=" "
    for spec in "${@:3}"; do
      layer=${spec%%:*}
      in=${spec#*:}
      [[ $spec == *:* && $layer =~ ^(rivers|reach_bins|waterbodies|canals)$ ]] || { echo "tiles: bad layer" >&2; exit 64; }
      [[ $seen != *" $layer "* ]] || { echo "tiles: layer $layer twice" >&2; exit 64; }
      seen+="$layer "
      [[ -f $in ]] || { echo "tiles: no such input for $layer" >&2; exit 64; }
      dir=$(cd "$(dirname "$in")" && pwd)
      [[ -z $indir || $dir == "$indir" ]] || { echo "tiles: the inputs must sit in one directory" >&2; exit 64; }
      indir=$dir
      inname=$(basename "$in")
      [[ $inname =~ ^[A-Za-z0-9._-]+$ ]] || { echo "tiles: bad input name" >&2; exit 64; }
      layers+=(-L "$layer:/work/in/$inname")
    done
    tool -v "$indir:/work/in:ro" -v "$outdir:/work/out" "$image" tippecanoe \
      -o "/work/out/$outname" --force --temporary-directory=/tmp --quiet \
      -Z0 -z12 -n "${outname%.pmtiles}" \
      -A "© OpenStreetMap contributors" -N "River network derived from OpenStreetMap, ODbL 1.0" \
      "${layers[@]}"
    ;;
  decode)
    (($# == 3)) || usage
    in=$2
    out=$3
    [[ -f $in ]] || { echo "tiles: no such input" >&2; exit 64; }
    indir=$(cd "$(dirname "$in")" && pwd)
    inname=$(basename "$in")
    outdir=$(cd "$(dirname "$out")" && pwd)
    outname=$(basename "$out")
    [[ $inname =~ ^[A-Za-z0-9._-]+\.pmtiles$ ]] || { echo "tiles: bad input name" >&2; exit 64; }
    tool -v "$indir:/work/in:ro" "$image" tippecanoe-decode "/work/in/$inname" >"$outdir/$outname"
    ;;
  *)
    usage
    ;;
esac
