#!/usr/bin/env bash
# Outside-in production check (issue #16 P1b; no SSH). The checks live in
# scripts/verify-prod.ts: this wrapper runs them with Node 26 after
# `pnpm install --frozen-lockfile`. Usage and modes: scripts/verify-prod.sh --dry-run x
set -euo pipefail
exec node "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/verify-prod.ts" "$@"
