#!/usr/bin/env bash
# The gate on a full-mode scripts/verify-prod.ts run against the CI compose stack (the printed lines in "$1"). Used by
# the CI deploy job (after run.sh, in the stack's own phase) and by run.sh (once in the launch phase, review CR-9), so
# both judge a run the same way. capture cannot succeed without internet in CI and the loaded data is a recorded
# fixture, so only the checks that need fresh production data may fail; the listed checks must PASS.
# test/verify-prod.test.ts reads this file (the allow-list and the required checks).
set -euo pipefail
out=${1:?usage: verify-gate.sh <verify-prod output>}
[[ -s $out ]] || { echo "verify-gate: $out is empty" >&2; exit 1; }
if grep '^FAIL' "$out" |
  grep -vE '^FAIL (freshness|owner_specs|health DE-1|tier-1 DE-1|loader lag|replay DE-1|health NL-1|tier-1 NL-1|replay NL-1|health FR-1|health CH-1|tier-1 FR-1|tier-1 CH-1|coverage FR-1|coverage CH-1|interval CH-1|belgian set|fresh DE-1|fresh NL-1|fresh FR-1|fresh CH-1|api build|health DE-7|tier-1 DE-7|coverage DE-7|health LU-1|tier-1 LU-1|coverage LU-1|interval DE-7|bytes DE-7|fresh DE-7|fresh LU-1|label offset LU-1|owner health|forecast NL-1|forecast CH-4|rivers manifest|rivers tiles|rivers reaches|rivers download|static settled|static frames|static series|static lag|static rerender) '; then
  echo "verify-gate: verify-prod failed a check other than the ones that need live data" >&2
  exit 1
fi
need() { grep -qE "$1" "$out" || { echo "verify-gate: no line matching $1" >&2; exit 1; }; }
need '^PASS headers / '
need '^PASS owner leak '
need '^PASS owner sources '
need '^PASS owner stations '
# "health" itself (the next word is the separator, not "params" or "DE-1").
need '^PASS health [^A-Za-z]'
need '^PASS health params '
# P4b: the data routes through Caddy, their Cache-Control per age class, and noindex on every kind of path.
# P6b: the page's bundle carries the river-network licence text (no rivers data is installed in CI).
for check in 'api meta' 'api stations' 'api snapshot now' 'api snapshot 6h' 'api snapshot 3d' 'api openapi' \
  'api params' 'noindex' 'rivers attribution' 'api states' 'class coverage' \
  'static meta' 'static latest' 'static stations' 'static sources' 'static recent' 'static forecast' \
  'static warnings' 'static status' 'static precompressed' 'runtime config' 'api sweep' 'pages' 'not found' \
  'robots' 'sitemap' 'legal pages' 'security.txt' 'og' 'cache-control' 'owner docs'; do
  need "^PASS $check "
done
# P12b: DE-2 is an owner source until the owner flips it (E1): the credit check is then N/A with its reason (N/A is
# printed padded to the four-character status column, hence ` +`).
need '^(PASS|N/A) +de-2 credit '
echo "verify-gate: ok ($out)"
