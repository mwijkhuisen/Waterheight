#!/usr/bin/env bash
# Re-exports the committed fixture PBF with the tool image and compares the result byte for byte with the committed
# exports (a .gz committed file is compared decompressed). Usage: export-check.sh <fixtures dir>   (RWS_GEO_IMAGE,
# default rws-geo-tools:local). Exit 0 when equal or when there is no fixture yet, 1 on a difference.
set -euo pipefail

(($# == 1)) || { echo "usage: export-check.sh <fixtures dir>" >&2; exit 64; }
fx=$(cd "$1" && pwd)
image=${RWS_GEO_IMAGE:-rws-geo-tools:local}

if [[ ! -f $fx/rivernet.osm.pbf ]]; then
  echo "export-check: no fixture yet"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$fx/rivernet.osm.pbf" "$work/rivernet.osm.pbf"

osm() {
  docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp \
    -u "$(id -u):$(id -g)" -v "$work:/work" -w /work "$image" osmium "$@"
}
osm export /work/rivernet.osm.pbf -f geojsonseq -a type,id,way_nodes --geometry-types=linestring \
  -o /work/rivernet.ways.geojsonseq --overwrite
osm cat /work/rivernet.osm.pbf -t relation -f opl,add_metadata=false -o /work/rivernet.relations.opl --overwrite

status=0
for name in rivernet.ways.geojsonseq rivernet.relations.opl; do
  if [[ -f $fx/$name ]]; then
    cmp -s "$work/$name" "$fx/$name" || { echo "export-check: $name differs" >&2; status=1; }
  elif [[ -f $fx/$name.gz ]]; then
    gzip -dc "$fx/$name.gz" | cmp -s "$work/$name" - || { echo "export-check: $name.gz differs" >&2; status=1; }
  else
    echo "export-check: $name is not committed" >&2
    status=1
  fi
done
((status == 0)) && echo "export-check: OK"
exit "$status"
