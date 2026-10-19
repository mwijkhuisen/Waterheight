#!/usr/bin/env bash
# River-network extract (P6a): downloads the Geofabrik regions one at a time, filters each to the waterway
# relations and the way selection, merges them, picks the curated relations and the way selection, and writes the
# four rivernet.* files that build.ts reads (and that become the fixture). P17b: from each region, before its
# download is deleted, also the water-body polygons of registry/waterbodies.yaml (by OSM id), merged into
# waterbodies.osm.pbf, its polygon export rivernet.waterbodies.geojsonseq and waterbodies.provenance.json. osmium runs
# only in the tool image, with no network. Usage: tools/geo/rivernet/extract.sh <workdir> <outdir>   (RWS_GEO_IMAGE,
# default rws-geo-tools:local; RWS_DOMAIN and RWS_CONTACT_EMAIL for the downloads; RWS_GEO_PROBE=1 also writes the
# one-off name probe <workdir>/probe/<region>.opl: the objects named like a water body, ids and tags only). Region
# ids, QIDs, OSM ids and probe names come from registry/geo-sources.yaml, registry/rivers.yaml and
# registry/waterbodies.yaml through sources.ts and are checked against fixed patterns before they reach a path or an
# argument.
set -euo pipefail
trap 'echo "extract: failed at line $LINENO" >&2' ERR

(($# == 2)) || { echo "usage: extract.sh <workdir> <outdir>" >&2; exit 64; }
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../../.." && pwd)
mkdir -p "$1" "$2"
work=$(cd "$1" && pwd)
outdir=$(cd "$2" && pwd)
image=${RWS_GEO_IMAGE:-rws-geo-tools:local}
OSMIUM_VERSION=1.19.1

osm() {
  docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp \
    -u "$(id -u):$(id -g)" -v "$work:/work" -w /work "$image" osmium "$@"
}
fail() { echo "extract: $*" >&2; exit 1; }

cd "$root"
mkdir -p "$work/dl" "$work/f" "$work/wb"

node tools/geo/rivernet/download.ts --check-index
node tools/geo/rivernet/sources.ts --selection "$work"

[[ -f $work/relations.txt && -f $work/qids.txt && -f $work/waterbodies.txt && -f $work/probe-names.txt ]] ||
  fail "sources.ts wrote no selection"
qids=$(tr -d '\n' <"$work/qids.txt")
[[ $qids =~ ^(Q[1-9][0-9]{0,9}(,Q[1-9][0-9]{0,9})*)?$ ]] || fail "bad qids.txt"
# A file passes only when grep finds no line outside the pattern (exit 1): a line outside it (0) or an error of grep
# itself (2) stops the run (review R2-2: `grep … && fail` let an error through).
only_lines() {
  local rc=0
  LC_ALL=C grep -qvE "$1" "$2" || rc=$?
  ((rc == 1))
}
only_lines '^r[1-9][0-9]*$' "$work/relations.txt" || fail "bad relations.txt"
[[ -s $work/waterbodies.txt ]] || fail "no water-body ids"
only_lines '^[rw][1-9][0-9]*$' "$work/waterbodies.txt" || fail "bad waterbodies.txt"

probe=${RWS_GEO_PROBE:-0}
[[ $probe == 0 || $probe == 1 ]] || fail "RWS_GEO_PROBE must be 0 or 1"
if ((probe == 1)); then
  # Each name becomes one value of an osmium tag filter: ASCII letters, space, hyphen and apostrophe, or the bytes
  # of a non-ASCII UTF-8 character (accents); a comma, an equals sign or a slash would change the expression.
  only_lines $'^([A-Za-z\' -]|[\x80-\xff])+$' "$work/probe-names.txt" || fail "bad probe-names.txt"
  mapfile -t probe_names <"$work/probe-names.txt"
  ((${#probe_names[@]} > 0)) || fail "no probe names"
  probe_filter=$(IFS=,; printf 'nwr/name=%s' "${probe_names[*]}")
  mkdir -p "$work/probe"
fi

mapfile -t ids < <(node tools/geo/rivernet/sources.ts --ids)
((${#ids[@]} > 0)) || fail "no region ids"

filter=(r/type=waterway)
[[ -z $qids ]] || filter+=("w/wikidata=$qids")

: >"$work/stamps.txt"
for id in "${ids[@]}"; do
  [[ $id =~ ^[a-z-]+$ ]] || fail "bad region id"
  node tools/geo/rivernet/download.ts --region "$id" --out "$work/dl"
  osm tags-filter "/work/dl/$id.osm.pbf" "${filter[@]}" -o "/work/f/$id.osm.pbf" --overwrite
  # The water bodies are no waterway relations, so they are taken from the download itself, with their ways and
  # nodes. getid exits 1 when a requested id is not in this region, which is normal here: the ids are checked once,
  # after the merge.
  status=0
  osm getid -r -i /work/waterbodies.txt "/work/dl/$id.osm.pbf" -o "/work/wb/$id.osm.pbf" --overwrite || status=$?
  ((status <= 1)) || fail "osmium getid of the water bodies failed for $id ($status)"
  if ((probe == 1)); then
    # Only the objects whose name matches (-R: no referenced nodes or ways), and of each OPL line only the id, the
    # tags and a node's coordinates: the node and member lists are dropped.
    osm tags-filter -R "/work/dl/$id.osm.pbf" "$probe_filter" -o "/work/probe/$id.osm.pbf" --overwrite
    osm cat "/work/probe/$id.osm.pbf" -f opl,add_metadata=false |
      awk '{ o = $1; for (i = 2; i <= NF; i++) if ($i !~ /^[NM]/) o = o " " $i; print o }' >"$work/probe/$id.opl"
    rm -f "$work/probe/$id.osm.pbf"
  fi
  stamp=$(osm fileinfo -g header.option.osmosis_replication_timestamp "/work/dl/$id.osm.pbf")
  [[ $stamp =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || fail "no_replication_timestamp for $id"
  printf '%s %s\n' "$id" "$stamp" >>"$work/stamps.txt"
  echo "$id replication timestamp $stamp"
  rm -f "$work/dl/$id.osm.pbf"
done

# Geofabrik cuts the regions at different moments (2026-10-02: Belgium a day after the rest), so a border
# object can be in two extracts in two versions. osmium merge keeps both (-H: no warning about that) and
# time-filter with no time keeps the newest valid version of each: the same inputs give the same result.
# Extracts more than 72 h apart are refused (extract_dates_too_far_apart): run again once Geofabrik has caught up.
oldest=$(cut -d' ' -f2 "$work/stamps.txt" | sort | head -n1)
stamp=$(cut -d' ' -f2 "$work/stamps.txt" | sort | tail -n1)
(($(date -u -d "$stamp" +%s) - $(date -u -d "$oldest" +%s) <= 72 * 3600)) || fail "extract_dates_too_far_apart"

merge_in=()
for id in "${ids[@]}"; do merge_in+=("/work/f/$id.osm.pbf"); done
osm merge -H "${merge_in[@]}" -o /work/merged-all.osm.pbf --overwrite
osm time-filter /work/merged-all.osm.pbf -o /work/merged.osm.pbf --overwrite
rm -f "$work/merged-all.osm.pbf"

# getid exits 1 both on an error and when a requested id is absent; an absent relation is reported here by id
# (build.ts then fails relation_missing), anything else stops the run.
status=0
osm getid -r -i /work/relations.txt /work/merged.osm.pbf -o /work/sel-rel.osm.pbf --overwrite || status=$?
((status <= 1)) || fail "osmium getid failed ($status)"
mapfile -t found < <(osm cat /work/sel-rel.osm.pbf -t relation -f opl,add_metadata=false | cut -d' ' -f1 | sort -u)
mapfile -t missing < <(comm -23 <(sort -u "$work/relations.txt") <(printf '%s\n' "${found[@]}"))
((${#missing[@]} == 0)) || echo "extract: relations not in the extract: ${missing[*]}" >&2
((status == 0 || ${#missing[@]} > 0)) || fail "osmium getid failed (1)"
sel=(/work/sel-rel.osm.pbf)
if [[ -n $qids ]]; then
  # Ways and relations that carry a selected QID: the way selections, the canal traps without a relation, and
  # any relation of a river that Wikidata gives no P402 (the build report lists those for review).
  osm tags-filter /work/merged.osm.pbf "w/wikidata=$qids" "r/wikidata=$qids" -o /work/sel-ways.osm.pbf --overwrite
  sel+=(/work/sel-ways.osm.pbf)
fi
osm merge "${sel[@]}" -o /work/rivernet.osm.pbf --output-format pbf,add_metadata=false --overwrite

osm export /work/rivernet.osm.pbf -f geojsonseq -a type,id,way_nodes --geometry-types=linestring \
  -o /work/rivernet.ways.geojsonseq --overwrite
osm cat /work/rivernet.osm.pbf -t relation -f opl,add_metadata=false -o /work/rivernet.relations.opl --overwrite

dl_files=()
for id in "${ids[@]}"; do dl_files+=("$work/dl/$id.download.json"); done
stamps_json=$(jq -R -s 'split("\n") | map(select(. != "") | split(" ") | {key: .[0], value: .[1]}) | from_entries' \
  "$work/stamps.txt")
jq -S -s --arg ts "$stamp" --arg osmium "$OSMIUM_VERSION" --argjson stamps "$stamps_json" '
  if all(.[]; .id != null and .url != null and .bytes != null and .md5 != null and .sha256 != null)
  then {schema_version: 1, osmium: $osmium, replication_timestamp: $ts,
        regions: (map({id, url, bytes, md5, sha256, replication_timestamp: $stamps[.id]}) | sort_by(.id))}
  else error("bad_download_json") end' "${dl_files[@]}" >"$work/rivernet.provenance.json"

copy_out() {
  for f in "$@"; do
    cp "$work/$f" "$outdir/$f"
    printf '%s %s %s\n' "$f" "$(stat -c %s "$outdir/$f")" "$(sha256sum "$outdir/$f" | cut -d' ' -f1)"
  done
}
# The river files go out first: a failure of the water-body part below still leaves them for the artifact.
copy_out rivernet.osm.pbf rivernet.ways.geojsonseq rivernet.relations.opl rivernet.provenance.json

# P17b: the water bodies, merged and made unique like the river extract. Only here is an absent id an error
# (waterbody_missing). --remove-tags keeps the tags of the requested objects only: a referenced way (an island ring,
# a stretch of shore) carries none, so osmium export assembles the requested polygons and no area of its own.
wb_in=()
for id in "${ids[@]}"; do wb_in+=("/work/wb/$id.osm.pbf"); done
osm merge -H "${wb_in[@]}" -o /work/wb-all.osm.pbf --overwrite
osm time-filter /work/wb-all.osm.pbf -o /work/wb-merged.osm.pbf --overwrite
rm -f "$work/wb-all.osm.pbf"
status=0
osm getid -r --remove-tags -i /work/waterbodies.txt /work/wb-merged.osm.pbf -o /work/waterbodies.osm.pbf \
  --output-format pbf,add_metadata=false --overwrite || status=$?
((status <= 1)) || fail "osmium getid of the water bodies failed ($status)"
mapfile -t found < <(osm cat /work/waterbodies.osm.pbf -f opl,add_metadata=false | cut -d' ' -f1 | grep -E '^[rw]' | sort -u)
mapfile -t missing < <(comm -23 <(sort -u "$work/waterbodies.txt") <(printf '%s\n' "${found[@]}"))
((${#missing[@]} == 0)) || fail "waterbody_missing: ${missing[*]}"
((status == 0)) || fail "osmium getid of the water bodies failed (1)"
osm export /work/waterbodies.osm.pbf -f geojsonseq -a type,id --geometry-types=polygon \
  -o /work/rivernet.waterbodies.geojsonseq --overwrite
jq -n -S --arg ts "$stamp" --arg osmium "$OSMIUM_VERSION" \
  '{schema_version: 1, osmium: $osmium, replication_timestamp: $ts}' >"$work/waterbodies.provenance.json"
copy_out waterbodies.osm.pbf rivernet.waterbodies.geojsonseq waterbodies.provenance.json
