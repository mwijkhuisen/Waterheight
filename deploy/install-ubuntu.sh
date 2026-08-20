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
PORT_EXPLICIT=0
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
    --port)         APP_PORT=$2; PORT_EXPLICIT=1; shift 2 ;;
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

  apt-get install -y -qq gnupg apt-transport-https lsb-release wget ca-certificates \
    postgresql-common >/dev/null

  # PostgreSQL's own archive (PGDG). Ubuntu ships exactly one major per release
  # -- 14 on 22.04, 16 on 24.04, 17 on 25.04, 18 on 26.04 -- so installing a
  # specific major without this fails with "Package 'postgresql-NN' has no
  # installation candidate" on every release whose archive does not happen to
  # match. PGDG carries all supported majors for all supported releases.
  if [[ ! -f /etc/apt/sources.list.d/pgdg.list && ! -f /etc/apt/sources.list.d/pgdg.sources ]]; then
    if [[ -x /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh ]]; then
      /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
      info "added the PostgreSQL (PGDG) apt repository"
    else
      warn "postgresql-common did not provide apt.postgresql.org.sh;"
      warn "falling back to whatever PostgreSQL Ubuntu's own archive carries"
    fi
  fi

  if [[ ! -f /etc/apt/trusted.gpg.d/timescaledb.gpg ]]; then
    echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ ${CODENAME} main" \
      > /etc/apt/sources.list.d/timescaledb.list
    wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey \
      | gpg --dearmor --yes -o /etc/apt/trusted.gpg.d/timescaledb.gpg
    info "added the Timescale apt repository"
  fi

  apt-get update -qq

  # True if apt can actually install this package right now.
  #
  # Deliberately no pipe: `apt-cache policy | grep -q` looks equivalent but
  # breaks under `set -o pipefail`. grep -q exits the moment it matches, apt-cache
  # then dies with SIGPIPE, and pipefail reports the pipeline as failed (141) --
  # so an available package reads as unavailable. Command substitution consumes
  # all the output, then bash matches the pattern itself.
  installable() {
    local policy
    policy=$(apt-cache policy "$1" 2>/dev/null) || return 1
    [[ $policy == *"Candidate: "[0-9]* ]]
  }

  # Which PostgreSQL majors actually have a server installed.
  #
  # Deliberately not `pg_config`. postgresql-common -- installed just above, to
  # get PGDG -- provides /usr/bin/pg_config as a shim that forwards to a real
  # one under $PGBINROOT. So on a machine with no PostgreSQL the binary exists
  # while running it prints "You need to install postgresql-server-dev-NN for
  # building a server-side extension or libpq-dev for building a client-side
  # application." and exits 1, which under `set -e` killed this script during
  # its own detection step. Probing the server directory is what the shim
  # itself does, and no shim can satisfy it.
  PGBINROOT=${PGBINROOT:-/usr/lib/postgresql/}
  installed_pg_majors() {
    local path major
    for path in "${PGBINROOT}"*/bin/pg_ctl; do
      [[ -x $path ]] || continue
      major=${path#"$PGBINROOT"}
      major=${major%%/*}
      [[ $major =~ ^[0-9]+$ ]] && printf '%s\n' "$major"
    done
  }

  # Reuse what is already here rather than installing a second cluster. A major
  # with a real cluster wins over one that is merely installed.
  if [[ -z $PG_MAJOR ]]; then
    PG_MAJOR=$(pg_lsclusters --no-header 2>/dev/null | awk 'NR==1 {print $1}') || PG_MAJOR=""
    if [[ ! $PG_MAJOR =~ ^[0-9]+$ ]]; then
      PG_MAJOR=$(installed_pg_majors | sort -n | tail -1) || PG_MAJOR=""
    fi
    if [[ -n $PG_MAJOR ]]; then
      info "reusing installed PostgreSQL $PG_MAJOR"
      if ! installable "timescaledb-2-postgresql-${PG_MAJOR}"; then
        die "PostgreSQL ${PG_MAJOR} is installed but Timescale publishes no
    timescaledb-2-postgresql-${PG_MAJOR} for ${CODENAME}. Install a major that
    Timescale supports and pass --pg-major, or upgrade the cluster."
      fi
    fi
  fi

  # Otherwise take the first major that BOTH archives can satisfy, rather than
  # a hardcoded guess that only holds on one Ubuntu release.
  #
  # 16 leads deliberately: it is what docker-compose pins and what this project
  # is tested against, so a native box and a compose box stay on one major and
  # a dump from either restores into the other. Newer majors follow for a
  # release that no longer carries 16, then older. --pg-major overrides.
  if [[ -z $PG_MAJOR ]]; then
    for candidate in 16 17 18 15; do
      if installable "postgresql-${candidate}" \
      && installable "timescaledb-2-postgresql-${candidate}"; then
        PG_MAJOR=$candidate
        break
      fi
    done
    [[ -n $PG_MAJOR ]] || die "no PostgreSQL major is installable with TimescaleDB on ${CODENAME}.
    Check that the Timescale repository has packages for this release:
      apt-cache search timescaledb-2-postgresql"
    info "no PostgreSQL found; installing ${PG_MAJOR}"
  fi

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

  # The file is authoritative once it exists, so --port would otherwise be
  # accepted and silently ignored. Report the port actually in effect, and say
  # plainly when it is not the one that was asked for.
  existing_port=$(sed -n 's/^PORT=\([0-9]\+\).*/\1/p' "$ENV_FILE" | tail -1)
  if [[ -n $existing_port ]]; then
    if [[ $PORT_EXPLICIT -eq 1 && $existing_port != "$APP_PORT" ]]; then
      warn "--port ${APP_PORT} ignored: .env already sets PORT=${existing_port}"
      warn "change it there and restart, or delete .env to have this rewrite it:"
      warn "  sed -i 's/^PORT=.*/PORT=${APP_PORT}/' ${ENV_FILE} && systemctl restart rws-api"
    fi
    APP_PORT=$existing_port
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

# The daily location refresh, the weekly correction re-fetch and the
# five-minute latest poll run inside the API process. Exactly one instance
# should carry them.
ENABLE_SCHEDULES=true
ENABLE_LATEST_POLL=true
LATEST_POLL_INTERVAL_MINUTES=5

CORS_ORIGIN=*
RATE_LIMIT_MAX=300
RATE_LIMIT_WINDOW_MS=60000
ENVEOF
  info "wrote ${ENV_FILE}"
fi

# WEB_ROOT is an absolute path, and an existing .env is never rewritten -- so a
# repository that has been moved keeps pointing at where it used to be, and the
# API silently serves no client at all.
web_root=$(sed -n 's/^WEB_ROOT=\(.*\)$/\1/p' "$ENV_FILE" | tail -1)
if [[ -n ${web_root:-} && ! -d $web_root ]]; then
  warn "WEB_ROOT in .env points at ${web_root}, which does not exist."
  warn "The API would start but serve no client. Fix it with:"
  warn "  sed -i 's|^WEB_ROOT=.*|WEB_ROOT=${REPO_DIR}/packages/web/dist|' ${ENV_FILE}"
fi

# The file holds the database password.
chown "root:${APP_USER}" "$ENV_FILE"
chmod 640 "$ENV_FILE"
info "secured ${ENV_FILE} (root:${APP_USER}, 0640)"

# The service account needs to read the tree it runs from.
chown -R "${APP_USER}:${APP_USER}" "${REPO_DIR}/packages" 2>/dev/null || true

# ...and it needs to be able to reach it at all. Ubuntu creates home directories
# mode 0750, so a repo under /home/<someone>/ is unreadable to any other user --
# including this service account. That surfaces only at `systemctl start`, as a
# bare "control process exited with error code", which is a poor way to find out.
if ! runuser -u "$APP_USER" -- test -r "${REPO_DIR}/package.json" 2>/dev/null; then
  home_owner=$(stat -c '%U' "$(dirname "${REPO_DIR}")" 2>/dev/null || echo '<owner>')
  die "${APP_USER} cannot read ${REPO_DIR}.

    Ubuntu creates *user* home directories mode 0750, so nothing inside one is
    reachable by another account. /home itself is 0755, so this is only about
    being nested inside a particular user's home -- keeping the app on the /home
    volume is entirely fine. Three ways, none of which move it off /home:

      1. Run the service as the user that already owns it. Best if your other
         web apps on this box run as their own user too:

           sudo ./deploy/install-ubuntu.sh --app-user ${home_owner}

      2. Move it one level up, out of the user's home but on the same volume:

           sudo mv ${REPO_DIR} /home/rws && cd /home/rws
           sudo sed -i 's|^WEB_ROOT=.*|WEB_ROOT=/home/rws/packages/web/dist|' /home/rws/.env
           sudo ./deploy/install-ubuntu.sh

      3. Keep both the location and a dedicated service account, and allow
         traversal of the home directory. This lets any local user traverse it;
         it does not make its contents listable:

           sudo chmod o+x $(dirname "${REPO_DIR}")
           sudo ./deploy/install-ubuntu.sh

    1 changes nothing on disk and is the least invasive."

fi

# --- port -------------------------------------------------------------------
# A box running several web applications runs out of free ports quietly. An
# occupied one surfaces only when the service starts, as EADDRINUSE followed by
# exit 1 -- which systemd reports as a bare "control process exited".
step "port ${APP_PORT}"
port_owner=""
if command -v ss >/dev/null; then
  port_owner=$(ss -lntpH "sport = :${APP_PORT}" 2>/dev/null | head -1 || true)
fi
if [[ -n ${port_owner:-} ]]; then
  # Ours already running is fine -- a restart takes the port back.
  if [[ $port_owner == *"rws"* || $port_owner == *"node"* ]]; then
    warn "port ${APP_PORT} is in use, seemingly by this app already:"
    warn "  ${port_owner}"
    warn "a restart will take it back; if not, another node process holds it"
  else
    die "port ${APP_PORT} is already in use by something else:

    ${port_owner}

    Pick a free one and re-run, or set PORT in .env and restart:

      sudo ./deploy/install-ubuntu.sh --port 3005
      # or, for an install that already exists:
      sudo sed -i 's/^PORT=.*/PORT=3005/' ${REPO_DIR}/.env
      sudo systemctl restart rws-api

    Ports currently listening on this machine:
$(ss -lntpH 2>/dev/null | awk '{print "      " $4}' | sort -u | head -20)"
  fi
else
  info "port ${APP_PORT} is free"
fi

# --- disk ------------------------------------------------------------------
# The checkout is a few hundred MB; the database is tens of GB once history is
# loaded. Those are frequently on different volumes, and the one that matters
# is rarely the one people think of.
step "disk"
pgdata=$(su postgres -c "psql -tAc 'SHOW data_directory'" 2>/dev/null || true)
if [[ -n ${pgdata:-} ]]; then
  avail_gb=$(df -BG --output=avail "$pgdata" 2>/dev/null | tail -1 | tr -dc '0-9')
  info "database directory ${pgdata} (${avail_gb:-?} GB free)"
  if [[ -n ${avail_gb:-} && $avail_gb -lt 30 ]]; then
    warn "under 30 GB free where the database lives. A year of history is"
    warn "~10-23 GB before indexes and WAL, so a full backfill may not fit."
    warn "See 'Putting the database on a bigger volume' in docs/INSTALL-UBUNTU.md."
  fi
fi

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
    # ProtectHome=true hides /home from the service entirely, so an install
    # that lives there needs read-only instead. Still hardened -- the service
    # only ever reads its own tree.
    if [[ $REPO_DIR == /home/* ]]; then
      PROTECT_HOME=read-only
      info "install is under /home; using ProtectHome=read-only so the unit can see it"
    else
      PROTECT_HOME=true
    fi

    for unit in rws-api.service rws-backfill.service; do
      sed -e "s|@REPO_DIR@|${REPO_DIR}|g" \
          -e "s|@APP_USER@|${APP_USER}|g" \
          -e "s|@NODE@|$(command -v node)|g" \
          -e "s|@PROTECT_HOME@|${PROTECT_HOME}|g" \
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
