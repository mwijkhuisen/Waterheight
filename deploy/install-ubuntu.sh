#!/usr/bin/env bash
#
# Provision this app on a normal Ubuntu machine -- no Docker anywhere.
#
# Installs PostgreSQL + TimescaleDB, creates the role and database, builds the
# server and the map client, writes .env, applies migrations and installs a
# systemd unit. Re-running is safe: every step checks for its own result first,
# so this doubles as the upgrade path.
#
# It deliberately does not touch MySQL/MariaDB. PostgreSQL listens on 5432 and
# MariaDB on 3306, they keep separate data directories and separate service
# units, so the two coexist on one box. The only thing they genuinely compete
# for is RAM -- see --pg-memory below.
#
#   sudo ./deploy/install-ubuntu.sh
#   sudo ./deploy/install-ubuntu.sh --pg-memory 4GB --port 3000
#
set -euo pipefail

# --- defaults ---------------------------------------------------------------
DB_NAME=rws
DB_USER=rws
DB_PASSWORD=
APP_USER=rws
APP_PORT=3000
PG_MEMORY=
PG_MAJOR=
SKIP_POSTGRES=0
SKIP_BUILD=0
SKIP_SERVICE=0
ALLOW_TESTDB=0

REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
NODE_MAJOR=22

usage() {
  sed -n '2,25p' "$0" | sed 's/^#\s\?//'
  cat <<'USAGE'

Options:
  --db-name <name>       database to create           (default: rws)
  --db-user <name>       role to create               (default: rws)
  --db-password <pw>     role password                (default: generated)
  --app-user <name>      system user to run as        (default: rws)
  --port <n>             port the API listens on      (default: 3000)
  --pg-memory <size>     memory budget for PostgreSQL tuning, e.g. 4GB.
                         Default: half of RAM when MariaDB/MySQL is present on
                         this machine, otherwise timescaledb-tune's own default.
  --pg-major <n>         PostgreSQL major version     (default: installed, else 16)
  --with-test-db         grant CREATEDB to the role so `npm test` can run its
                         integration suite. Not needed to serve traffic.
  --skip-postgres        assume the database already exists
  --skip-build           assume npm ci + build already ran
  --skip-service         do not install the systemd unit
  -h, --help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-name)      DB_NAME=$2; shift 2 ;;
    --db-user)      DB_USER=$2; shift 2 ;;
    --db-password)  DB_PASSWORD=$2; shift 2 ;;
    --app-user)     APP_USER=$2; shift 2 ;;
    --port)         APP_PORT=$2; shift 2 ;;
    --pg-memory)    PG_MEMORY=$2; shift 2 ;;
    --pg-major)     PG_MAJOR=$2; shift 2 ;;
    --with-test-db) ALLOW_TESTDB=1; shift ;;
    --skip-postgres) SKIP_POSTGRES=1; shift ;;
    --skip-build)   SKIP_BUILD=1; shift ;;
    --skip-service) SKIP_SERVICE=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# `systemctl` exists on machines that are not booted under systemd (containers,
# chroots), and some of its subcommands still exit 0 there -- `is-enabled`
# does, while printing "Failed to connect to bus" to stderr. So probe for the
# runtime directory instead, which is the only reliable signal.
have_systemd() { [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null; }

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    warning: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo: sudo $0 $*"
command -v apt-get >/dev/null || die "this script targets Debian/Ubuntu (no apt-get found)"

. /etc/os-release
info "detected ${PRETTY_NAME:-unknown}"
CODENAME=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
[[ -n $CODENAME ]] || die "cannot determine the Ubuntu codename"

export DEBIAN_FRONTEND=noninteractive

# --- Node -------------------------------------------------------------------
# Ubuntu's own `nodejs` package is 18.x on 24.04, and package.json requires
# >=20. Installing from apt therefore produces a build that fails at runtime,
# so pull Node from NodeSource instead.
step "Node.js >= 20"
node_ok=0
if command -v node >/dev/null; then
  current=$(node -p 'process.versions.node.split(".")[0]')
  if [[ $current -ge 20 ]]; then
    info "node $(node -v) already installed"
    node_ok=1
  else
    warn "node $(node -v) is too old (need >= 20); installing Node ${NODE_MAJOR}.x"
  fi
fi

if [[ $node_ok -eq 0 ]]; then
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  chmod a+r /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
  info "installed node $(node -v)"
fi

# --- PostgreSQL + TimescaleDB ----------------------------------------------
if [[ $SKIP_POSTGRES -eq 0 ]]; then
  step "PostgreSQL + TimescaleDB"

  # Reuse the cluster that is already here rather than installing a second one.
  if [[ -z $PG_MAJOR ]]; then
    if command -v pg_config >/dev/null; then
      PG_MAJOR=$(pg_config --version | sed -E 's/^PostgreSQL ([0-9]+).*/\1/')
      info "reusing installed PostgreSQL $PG_MAJOR"
    else
      PG_MAJOR=16
      info "no PostgreSQL found; installing $PG_MAJOR"
    fi
  fi

  apt-get install -y -qq gnupg apt-transport-https lsb-release wget ca-certificates >/dev/null

  if [[ ! -f /etc/apt/trusted.gpg.d/timescaledb.gpg ]]; then
    echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ ${CODENAME} main" \
      > /etc/apt/sources.list.d/timescaledb.list
    wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey \
      | gpg --dearmor --yes -o /etc/apt/trusted.gpg.d/timescaledb.gpg
    info "added the Timescale apt repository"
  fi

  apt-get update -qq
  apt-get install -y -qq \
    "postgresql-${PG_MAJOR}" "postgresql-client-${PG_MAJOR}" \
    "timescaledb-2-postgresql-${PG_MAJOR}" timescaledb-tools >/dev/null
  info "installed timescaledb-2-postgresql-${PG_MAJOR}"

  # Memory. timescaledb-tune sizes shared_buffers and effective_cache_size as
  # if PostgreSQL owned the whole machine. On a box that is also running
  # MariaDB, that overcommits: both engines size their caches to the same RAM
  # and the OOM killer eventually settles it. So when another database is
  # present and no budget was given, take half.
  if [[ -z $PG_MEMORY ]]; then
    other_db=""
    for unit in mariadb mysql mysqld; do
      if have_systemd && systemctl list-unit-files 2>/dev/null | grep -q "^${unit}\.service"; then
        other_db=$unit; break
      fi
    done
    # Without systemd to ask, look for the server binary itself.
    if [[ -z $other_db ]] && ! have_systemd; then
      for bin in mariadbd mysqld; do
        command -v "$bin" >/dev/null && { other_db=$bin; break; }
      done
    fi
    if [[ -n $other_db ]]; then
      total_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
      PG_MEMORY="$(( total_kb / 2 / 1024 ))MB"
      warn "${other_db} is installed on this machine; budgeting ${PG_MEMORY} for PostgreSQL"
      warn "so the two do not size their caches to the same RAM. Override with --pg-memory."
    fi
  fi

  tune_args=(--quiet --yes --pg-config "/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config")
  [[ -n $PG_MEMORY ]] && tune_args+=(--memory "$PG_MEMORY")
  timescaledb-tune "${tune_args[@]}" >/dev/null
  info "tuned /etc/postgresql/${PG_MAJOR}/main/postgresql.conf${PG_MEMORY:+ for $PG_MEMORY}"

  # shared_preload_libraries only takes effect on a restart.
  if have_systemd; then
    systemctl restart postgresql
  else
    pg_ctlcluster "$PG_MAJOR" main restart || pg_ctlcluster "$PG_MAJOR" main start
  fi

  for _ in $(seq 30); do
    su postgres -c "psql -tAc 'SELECT 1'" >/dev/null 2>&1 && break
    sleep 1
  done
  su postgres -c "psql -tAc 'SELECT 1'" >/dev/null 2>&1 \
    || die "PostgreSQL did not come up; see /var/log/postgresql/"
  info "PostgreSQL is accepting connections"
fi

# --- role and database ------------------------------------------------------
step "database ${DB_NAME} and role ${DB_USER}"
role_exists=$(su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'\"")

if [[ $role_exists == 1 ]]; then
  info "role ${DB_USER} already exists; leaving its password alone"
  [[ -z $DB_PASSWORD ]] && info "reusing the password already in .env (if any)"
else
  if [[ -z $DB_PASSWORD ]]; then
    # No default password is ever baked in: a generated one cannot be guessed
    # and cannot be reused across machines by accident.
    DB_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
    info "generated a password for ${DB_USER}"
  fi
  su postgres -c "psql -v ON_ERROR_STOP=1 -c \"CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}'\"" >/dev/null
  info "created role ${DB_USER}"
fi

db_exists=$(su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'\"")
if [[ $db_exists == 1 ]]; then
  info "database ${DB_NAME} already exists"
else
  su postgres -c "psql -v ON_ERROR_STOP=1 -c \"CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}\"" >/dev/null
  info "created database ${DB_NAME}"
fi

if [[ $ALLOW_TESTDB -eq 1 ]]; then
  # The integration suite creates and drops a throwaway database per run.
  su postgres -c "psql -v ON_ERROR_STOP=1 -c \"ALTER ROLE ${DB_USER} CREATEDB\"" >/dev/null
  info "granted CREATEDB to ${DB_USER} (for npm test)"
fi

# CREATE EXTENSION needs superuser, so it happens here rather than in the
# migration -- 001_extension.sql is then a no-op that keeps the Docker path
# working unchanged.
su postgres -c "psql -v ON_ERROR_STOP=1 -d ${DB_NAME} -c 'CREATE EXTENSION IF NOT EXISTS timescaledb'" >/dev/null
ts_version=$(su postgres -c "psql -tAd ${DB_NAME} -c \"SELECT extversion FROM pg_extension WHERE extname='timescaledb'\"")
info "timescaledb ${ts_version} enabled in ${DB_NAME}"

# --- application user -------------------------------------------------------
step "system user ${APP_USER}"
if id -u "$APP_USER" >/dev/null 2>&1; then
  info "user ${APP_USER} already exists"
else
  # A service account: no login shell, no home of its own to manage.
  adduser --system --group --no-create-home --disabled-login "$APP_USER" >/dev/null
  info "created system user ${APP_USER}"
fi

# --- build ------------------------------------------------------------------
if [[ $SKIP_BUILD -eq 0 ]]; then
  step "build"
  cd "$REPO_DIR"
  if [[ -f package-lock.json ]]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
  npm run build            # @rws/shared + @rws/server
  npm run build:web        # the map client
  info "built server and client"
fi

# --- .env -------------------------------------------------------------------
step "configuration"
ENV_FILE="${REPO_DIR}/.env"
if [[ -f $ENV_FILE ]]; then
  info ".env already exists; leaving it untouched"
  if [[ -n $DB_PASSWORD ]] && ! grep -q "^DATABASE_URL=" "$ENV_FILE"; then
    warn "no DATABASE_URL in the existing .env -- the app will fall back to defaults"
  fi
else
  [[ -n $DB_PASSWORD ]] || die "role ${DB_USER} exists but no password is known; pass --db-password"
  cat > "$ENV_FILE" <<ENVEOF
# Written by deploy/install-ubuntu.sh. Real environment variables override
# anything set here, so the systemd unit can still take precedence.

PORT=${APP_PORT}
HOST=0.0.0.0
LOG_LEVEL=info

DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}
TEST_DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@localhost:5432/postgres

# Serve the built map client from the API, so the whole app is one origin.
WEB_ROOT=${REPO_DIR}/packages/web/dist

# The daily location refresh and the weekly correction re-fetch run inside the
# API process. Exactly one instance should carry them.
ENABLE_SCHEDULES=true

CORS_ORIGIN=*
RATE_LIMIT_MAX=300
RATE_LIMIT_WINDOW_MS=60000
ENVEOF
  info "wrote ${ENV_FILE}"
fi

# The file holds the database password.
chown "root:${APP_USER}" "$ENV_FILE"
chmod 640 "$ENV_FILE"
info "secured ${ENV_FILE} (root:${APP_USER}, 0640)"

# The service account needs to read the tree it runs from.
chown -R "${APP_USER}:${APP_USER}" "${REPO_DIR}/packages" 2>/dev/null || true

# --- migrations -------------------------------------------------------------
step "migrations"
cd "$REPO_DIR"
ENV_FILE="$ENV_FILE" node packages/server/dist/cli/migrate.js

# --- systemd ----------------------------------------------------------------
if [[ $SKIP_SERVICE -eq 0 ]]; then
  step "systemd service"
  if ! have_systemd; then
    warn "not booted under systemd; skipping the unit files"
    warn "run the API yourself with: node packages/server/dist/index.js"
  else
    for unit in rws-api.service rws-backfill.service; do
      sed -e "s|@REPO_DIR@|${REPO_DIR}|g" \
          -e "s|@APP_USER@|${APP_USER}|g" \
          -e "s|@NODE@|$(command -v node)|g" \
          "${REPO_DIR}/deploy/${unit}" > "/etc/systemd/system/${unit}"
      info "installed /etc/systemd/system/${unit}"
    done
    systemctl daemon-reload
    systemctl enable --now rws-api.service
    sleep 2
    if systemctl is-active --quiet rws-api.service; then
      info "rws-api is running"
    else
      warn "rws-api did not start; journalctl -u rws-api -n 50"
    fi
  fi
fi

# --- next steps -------------------------------------------------------------
cat <<DONE

$(printf '\033[1m==> installed\033[0m')

    API          http://localhost:${APP_PORT}/
    health       curl -s http://localhost:${APP_PORT}/api/health | jq
    logs         journalctl -u rws-api -f

The database is empty until the location layer is loaded. This takes ~6 minutes
and must finish before the map shows anything:

    cd ${REPO_DIR}
    sudo -u ${APP_USER} node packages/server/dist/cli/refresh.js

Then load history -- see "Loading history" in the README:

    sudo -u ${APP_USER} node packages/server/dist/cli/backfill.js --dry-run
    sudo systemctl start rws-backfill      # the real run, ~2.5h, resumable

DONE
