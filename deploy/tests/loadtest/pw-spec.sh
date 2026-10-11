#!/usr/bin/env bash
# CI only (loadtest.yml, chaos.sh; as root): runs one compose-mode Playwright spec (apps/web/e2e/<spec>.spec.ts, selected
# by E2E_SPEC; playwright.config.ts) in the pinned image against the running stack, as deploy/tests/e2e/run.sh does for
# degraded.spec.ts. PLAYWRIGHT_IMAGE comes from the workflow. Extra arguments go to `docker run` (-e, -v).
#   pw-spec.sh <spec name> [docker run args...]
set -euo pipefail
spec=${1:?usage: pw-spec.sh <spec name> [docker run args...]}
shift
: "${PLAYWRIGHT_IMAGE:?set PLAYWRIGHT_IMAGE}"
set -a
# shellcheck source=/dev/null
. /ci/loadtest.env
set +a
exec docker run --rm --init --network host --ipc=host --add-host "$RWS_E2E_DOMAIN:$RWS_E2E_CADDY_IP" \
  -e CI=true -e E2E_COMPOSE=1 -e "E2E_SPEC=$spec" -e "E2E_COMPOSE_URL=https://$RWS_E2E_DOMAIN" "$@" \
  -v "$RWS_E2E_REPO:/work" -w /work/apps/web \
  "$PLAYWRIGHT_IMAGE" xvfb-run --auto-servernum --server-args='-screen 0 1280x1024x24' \
  node_modules/.bin/playwright test -c e2e/playwright.config.ts --project=chromium
