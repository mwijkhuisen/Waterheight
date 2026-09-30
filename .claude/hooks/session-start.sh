#!/usr/bin/env bash
# SessionStart hook: prepares a claude.ai/code session so that `pnpm check` and
# `pnpm test:integration` pass with no manual step (ADR-0015).
#
# - Acts only when CLAUDE_CODE_REMOTE=true; everywhere else it exits 0 at once.
# - Idempotent: every step checks first, so a second run changes nothing.
# - No curl | sh. Every download is pinned: Node by sha256 (from the signed
#   SHASUMS256.txt of v26.10.0), pnpm by sha512 (scripts/install-pnpm.sh, no
#   corepack), PostgreSQL 18 from the signed apt.postgresql.org repository whose
#   key file is sha256-pinned (fingerprint B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8).
# - PostgreSQL: cluster 18/rws on localhost:5433 only, builtin C.UTF-8 locale.
#   Role rws is a SUPERUSER of this throwaway sandbox cluster (the integration
#   tests create the production roles and a database per test file) and logs
#   in over loopback TCP without a password (trust, so no password exists to
#   leak into $CLAUDE_ENV_FILE or the log). Other roles log in over loopback
#   with scram-sha-256 (the tests' throw-away passwords, so the role settings
#   apply as in production); the superuser postgres never over TCP.
# - Writes PATH and DATABASE_URL to $CLAUDE_ENV_FILE, then runs
#   `pnpm install --frozen-lockfile`.
#
# Trust boundary: the session runs the copy of this file on the branch it checks
# out, including PR branches under review (docs/threat-model.md, T-AGENT-2).
set -euo pipefail

[[ ${CLAUDE_CODE_REMOTE:-} == true ]] || exit 0

readonly NODE_VERSION=26.10.0
declare -A NODE_SHA256=(
  [x64]=ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022
  [arm64]=7a6353f63eb3d04765004b4adf172616243e4522434635cb1d26288658b04ab5
)
readonly PGDG_KEY_URL=https://www.postgresql.org/media/keys/ACCC4CF8.asc
readonly PGDG_KEY_SHA256=0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76
readonly PG_MAJOR=18 PG_CLUSTER=rws PG_PORT=5433 PG_ROLE=rws PG_DB=rws

log() { printf 'session-start: %s\n' "$*"; }
as_root() { if [[ $(id -u) -eq 0 ]]; then "$@"; else sudo -n "$@"; fi; }
as_postgres() { if [[ $(id -u) -eq 0 ]]; then runuser -u postgres -- "$@"; else sudo -n -u postgres "$@"; fi; }
fetch() { curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"; }

project=${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}
prefix=${RWS_TOOLS_PREFIX:-$HOME/.local/share/rws-tools}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

case $(uname -m) in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) log "unsupported machine $(uname -m)" >&2; exit 1 ;;
esac

# 1. Node.js
node_dir=$prefix/node-v$NODE_VERSION-linux-$arch
if [[ -x $node_dir/bin/node && $("$node_dir/bin/node" --version) == "v$NODE_VERSION" ]]; then
  log "ok: node $NODE_VERSION"
else
  log "installing node $NODE_VERSION"
  tarball=node-v$NODE_VERSION-linux-$arch.tar.xz
  fetch "https://nodejs.org/dist/v$NODE_VERSION/$tarball" "$tmp/$tarball"
  echo "${NODE_SHA256[$arch]}  $tmp/$tarball" | sha256sum -c --quiet -
  mkdir -p "$prefix"
  tar -xJf "$tmp/$tarball" -C "$prefix"
fi

# 2. pnpm (the script is idempotent and says whether it installed anything)
"$project/scripts/install-pnpm.sh" "$prefix"

export PATH=$node_dir/bin:$prefix/bin:$PATH

# 3. PostgreSQL 18
bindir=/usr/lib/postgresql/$PG_MAJOR/bin
if [[ -x $bindir/postgres ]]; then
  log "ok: postgresql $PG_MAJOR"
else
  log "installing postgresql-$PG_MAJOR from apt.postgresql.org"
  fetch "$PGDG_KEY_URL" "$tmp/pgdg.asc"
  echo "$PGDG_KEY_SHA256  $tmp/pgdg.asc" | sha256sum -c --quiet -
  codename=$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release)
  [[ -n $codename ]] || { log "no VERSION_CODENAME in /etc/os-release" >&2; exit 1; }
  as_root install -D -m 0644 "$tmp/pgdg.asc" /usr/share/keyrings/pgdg.asc
  echo "deb [signed-by=/usr/share/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt $codename-pgdg main" |
    as_root tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  # Only our cluster: no automatic 18/main that could take port 5433.
  as_root install -d /etc/postgresql-common/createcluster.d
  echo 'create_main_cluster = false' | as_root tee /etc/postgresql-common/createcluster.d/rws.conf >/dev/null
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "postgresql-$PG_MAJOR" >/dev/null
fi

# 4. The cluster: localhost:5433, builtin C.UTF-8, loopback only. Over TCP the
#    role rws without a password, other roles with scram-sha-256; postgres only
#    through the local peer socket.
if ! pg_lsclusters -h | awk -v v="$PG_MAJOR" -v c="$PG_CLUSTER" '$1 == v && $2 == c { found = 1 } END { exit !found }'; then
  log "creating cluster $PG_MAJOR/$PG_CLUSTER on port $PG_PORT"
  as_root pg_createcluster "$PG_MAJOR" "$PG_CLUSTER" --port "$PG_PORT" --locale C.UTF-8 \
    -o listen_addresses=localhost -- \
    --locale-provider=builtin --builtin-locale=C.UTF-8 --encoding=UTF8 --auth-host=reject --auth-local=peer >/dev/null
fi
hba=/etc/postgresql/$PG_MAJOR/$PG_CLUSTER/pg_hba.conf
hba_want="# Managed by .claude/hooks/session-start.sh
local all all peer
host all $PG_ROLE 127.0.0.1/32 trust
host all $PG_ROLE ::1/128 trust
host all postgres all reject
host all all 127.0.0.1/32 scram-sha-256
host all all ::1/128 scram-sha-256
host all all all reject"
hba_changed=0
if [[ $(as_root cat "$hba") != "$hba_want" ]]; then
  log "writing $hba"
  printf '%s\n' "$hba_want" | as_root tee "$hba" >/dev/null
  hba_changed=1
fi
if ! pg_lsclusters -h | awk -v v="$PG_MAJOR" -v c="$PG_CLUSTER" '$1 == v && $2 == c && $4 == "online" { found = 1 } END { exit !found }'; then
  log "starting cluster $PG_MAJOR/$PG_CLUSTER"
  as_root pg_ctlcluster "$PG_MAJOR" "$PG_CLUSTER" start
elif ((hba_changed)); then
  log "reloading cluster $PG_MAJOR/$PG_CLUSTER"
  as_root pg_ctlcluster "$PG_MAJOR" "$PG_CLUSTER" reload
fi
psql_admin() { as_postgres psql -X -q -p "$PG_PORT" -v ON_ERROR_STOP=1 -Atc "$1"; }
case $(psql_admin "select rolsuper from pg_roles where rolname = '$PG_ROLE'") in
  t) ;;
  f)
    log "writing role $PG_ROLE: superuser"
    psql_admin "alter role $PG_ROLE superuser"
    ;;
  *)
    log "creating role $PG_ROLE (superuser)"
    psql_admin "create role $PG_ROLE login superuser"
    ;;
esac
if [[ -z $(psql_admin "select 1 from pg_database where datname = '$PG_DB'") ]]; then
  log "creating database $PG_DB"
  psql_admin "create database $PG_DB owner $PG_ROLE"
fi

# 5. The session environment (appended once; no secret in it).
export DATABASE_URL="postgres://$PG_ROLE@localhost:$PG_PORT/$PG_DB?sslmode=disable"
if [[ -n ${CLAUDE_ENV_FILE:-} ]]; then
  for line in "export PATH=\"$node_dir/bin:$prefix/bin:\$PATH\"" "export DATABASE_URL=\"$DATABASE_URL\""; do
    if ! grep -qxF -- "$line" "$CLAUDE_ENV_FILE" 2>/dev/null; then
      log "writing ${line%%=*} to CLAUDE_ENV_FILE"
      printf '%s\n' "$line" >>"$CLAUDE_ENV_FILE"
    fi
  done
else
  log "CLAUDE_ENV_FILE is not set; PATH and DATABASE_URL apply to this hook only" >&2
fi

# 6. Dependencies, exactly as locked.
cd "$project"
pnpm install --frozen-lockfile
# A statement of its own, so a failed connection fails the hook (set -e).
server_version=$(psql -X -h localhost -p "$PG_PORT" -U "$PG_ROLE" -d "$PG_DB" -Atc 'show server_version')
log "ready: node $(node --version), pnpm $(pnpm --version), PostgreSQL $server_version"
