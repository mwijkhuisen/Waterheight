# Installing on Ubuntu, without Docker

A step-by-step install on an ordinary Ubuntu machine: PostgreSQL and TimescaleDB
from apt, the app built in place, and systemd keeping it running. No containers
are involved at any point.

Everything below was run end to end on a clean **Ubuntu 24.04** box. It also
applies to 22.04 and 26.04; the only version-specific part is the apt
repository lines, which are derived from the release codename automatically.

Note that Timescale publishes for LTS releases only — 22.04 `jammy`, 24.04
`noble`, 26.04 `resolute` — not for the interim releases in between.

- [Before you start](#before-you-start)
- [The short version](#the-short-version)
- [Step by step](#step-by-step)
- [Loading data](#loading-data)
- [Putting it behind a reverse proxy](#putting-it-behind-a-reverse-proxy)
- [Operating it](#operating-it)
- [Troubleshooting](#troubleshooting)
- [Uninstalling](#uninstalling)

## Before you start

**Sizing.** Driven by the Phase 1 measurements in
[`spike/PHASE1-FINDINGS.md`](../spike/PHASE1-FINDINGS.md), not guesswork:

| | |
|---|---|
| Locations tracked | ~2,600 |
| Rows for one year of history | ~190 million across the whole network; ~88 million when 568 are active |
| Disk, uncompressed | ~10-23 GB, scaling with the above |
| Disk, after the 90-day compression policy | substantially less; budget 30 GB and watch it |
| RAM | 4 GB works; 8 GB+ if this box also runs another database |
| Download time, eager tier | ~2.5-3 h |
| Download time, everything | ~8 h |

You do **not** need any of that to get a working map: the location layer alone
(~6 minutes) is enough, and observations for short periods are fetched from
Rijkswaterstaat on demand. History is optional and can be loaded later.

**Outbound network.** The machine must reach
`ddapi20-waterwebservices.rijkswaterstaat.nl` and `geo.rijkswaterstaat.nl` over
HTTPS. If your network forces an outbound proxy, see
[Troubleshooting](#the-app-starts-but-apihealth-reports-upstream-unreachable).

**Already running MariaDB or MySQL?** That is fine, and it changes nothing about
the steps below — PostgreSQL listens on 5432, MariaDB on 3306, and they keep
separate data directories and service units. The one thing to get right is
memory, covered in [step 2](#2-postgresql-and-timescaledb).

## The short version

```sh
git clone https://github.com/mwijkhuisen/rws.git /opt/rws
cd /opt/rws
sudo ./deploy/install-ubuntu.sh
```

That script performs every step in the next section and is safe to re-run — each
step checks for its own result first, so it doubles as the upgrade path. Useful
flags:

```sh
sudo ./deploy/install-ubuntu.sh --pg-memory 4GB   # cap PostgreSQL's memory budget
sudo ./deploy/install-ubuntu.sh --with-test-db    # also allow `npm test` to run
sudo ./deploy/install-ubuntu.sh --port 8080       # listen somewhere else
sudo ./deploy/install-ubuntu.sh --help            # all of them
```

When it finishes, go to [Loading data](#loading-data).

## Step by step

Do this instead of the script if you want to understand or adapt each piece.

### 1. Node.js

Ubuntu 24.04 packages Node **18**, and this app requires **20 or newer**
(`engines` in `package.json`). `apt install nodejs` therefore produces an
install that fails at runtime. Use NodeSource:

```sh
sudo apt-get install -y ca-certificates curl gnupg
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt-get update && sudo apt-get install -y nodejs
node -v    # v22.x
```

### 2. PostgreSQL and TimescaleDB

Two repositories are needed. Ubuntu's archive carries exactly one PostgreSQL
major per release — 14 on 22.04, 16 on 24.04, 17 on 25.04, **18 on 26.04** — so
asking for a specific one without **PGDG** (PostgreSQL's own archive) fails with
`Package 'postgresql-16' has no installation candidate`. TimescaleDB is not in
Ubuntu's archive at all.

```sh
# PGDG: every supported PostgreSQL major, for every supported Ubuntu release.
sudo apt-get install -y gnupg apt-transport-https lsb-release wget postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y

# TimescaleDB.
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/timescaledb.list
wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey \
  | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/timescaledb.gpg

sudo apt-get update
sudo apt-get install -y postgresql-16 postgresql-client-16 \
                        timescaledb-2-postgresql-16 timescaledb-tools
```

16 is used here because it is what `docker-compose` pins and what this project
is tested against, so both deployment paths stay on one major and a dump from
either restores into the other. Any major with a matching
`timescaledb-2-postgresql-NN` works; check with
`apt-cache search timescaledb-2-postgresql`.

**On Ubuntu 26.04 this is a real choice.** 26.04 ships PostgreSQL 18 in its own
archive, while Timescale publishes `timescaledb-2-postgresql-16`, `-17` and
`-18` for it. The installer defaults to 16 from PGDG, because that is the
combination this project has actually been verified against end to end
(migrations, hypertable, both continuous aggregates, the compression policy,
backfill and API). If you would rather run the OS-native major and take
PostgreSQL updates from Ubuntu, that is well supported:

```sh
sudo ./deploy/install-ubuntu.sh --pg-major 18
```

Nothing in the schema is version-specific, so 18 is expected to work — it just
has not been exercised here, which is the whole of the difference.

If PostgreSQL is already installed, match its major version rather than adding a
second cluster — `pg_config --version` tells you which. The installer script
does all of this for you, including picking the version.

Now tune it. **This is the step that matters if MariaDB is on the same box.**
`timescaledb-tune` sizes `shared_buffers` and `effective_cache_size` as though
PostgreSQL owned all the RAM. Run it unqualified next to MariaDB and both
engines size their caches to the same memory, which the OOM killer eventually
settles. Give it an explicit budget instead:

```sh
sudo timescaledb-tune --quiet --yes --memory 4GB   # roughly half your RAM
sudo systemctl restart postgresql                  # loads the extension library
```

`--memory` is only a tuning input; PostgreSQL is not hard-limited to it. If you
want a hard ceiling, run the unit under a systemd `MemoryMax=`.

Confirm the extension is available:

```sh
sudo -u postgres psql -tAc \
  "SELECT default_version FROM pg_available_extensions WHERE name='timescaledb'"
```

### 3. Database and role

```sh
sudo -u postgres psql -c "CREATE ROLE rws LOGIN PASSWORD 'choose-something-strong'"
sudo -u postgres psql -c "CREATE DATABASE rws OWNER rws"
sudo -u postgres psql -d rws -c "CREATE EXTENSION IF NOT EXISTS timescaledb"
```

`CREATE EXTENSION` needs superuser, which is why it is done here rather than
left to the migration. Migration `001_extension.sql` is then a no-op.

Only if you intend to run the test suite on this machine — the integration tests
create and drop a throwaway database per run:

```sh
sudo -u postgres psql -c "ALTER ROLE rws CREATEDB"
```

### 4. A user to run as

```sh
sudo adduser --system --group --no-create-home --disabled-login rws
```

### 5. Build

```sh
cd /opt/rws
npm ci
npm run build        # @rws/shared + @rws/server
npm run build:web    # the map client
```

### 6. Configure

```sh
cp .env.example .env
$EDITOR .env
```

The values that matter for a native install:

```ini
DATABASE_URL=postgres://rws:choose-something-strong@localhost:5432/rws
WEB_ROOT=/opt/rws/packages/web/dist
ENABLE_SCHEDULES=true
PORT=3000
```

`WEB_ROOT` is what makes the API serve the built map client, so the whole app is
one origin and the browser never needs CORS. Leave it empty for an API-only
instance.

`ENABLE_SCHEDULES=true` runs the daily location refresh and the weekly
correction re-fetch inside the API process. Turn it on for exactly one instance.

**Changing the port.** `PORT` is the only place it is set — the client calls the
API on relative paths, so it follows the server wherever it listens, and the
systemd unit reads `.env` rather than hardcoding anything. To run on 3002:

```sh
sudo sed -i 's/^PORT=.*/PORT=3002/' /opt/rws/.env
sudo systemctl restart rws-api
curl -s localhost:3002/api/health | jq -r .status
```

On a *first* install you can ask for it up front with
`sudo ./deploy/install-ubuntu.sh --port 3002`. Once `.env` exists the file wins
and `--port` is ignored — the script says so rather than pretending otherwise.
If a reverse proxy sits in front, update its `proxy_pass` to match.

The file holds a database password, so lock it down:

```sh
sudo chown root:rws .env && sudo chmod 640 .env
```

`.env` is found relative to the application, not the shell's working directory,
so `npm run migrate` and the CLIs pick it up from anywhere. Point `ENV_FILE` at
a different path to override — that is what the systemd unit does. Real
environment variables always win over the file.

### 7. Migrations

```sh
node packages/server/dist/cli/migrate.js
```

Expect 11 migrations. They are forward-only and checksum-guarded: editing one
that has already been applied is a hard error rather than silent divergence.

### 8. systemd

```sh
sudo cp deploy/rws-api.service deploy/rws-backfill.service /etc/systemd/system/
sudo sed -i -e "s|@REPO_DIR@|/opt/rws|g" -e "s|@APP_USER@|rws|g" \
            -e "s|@NODE@|$(command -v node)|g" \
            /etc/systemd/system/rws-api.service /etc/systemd/system/rws-backfill.service
sudo systemctl daemon-reload
sudo systemctl enable --now rws-api
systemctl status rws-api
```

The unit applies pending migrations via `ExecStartPre` before the listener
opens, restarts on failure, and runs with the filesystem read-only except for a
private `/tmp`.

Check it:

```sh
curl -s http://localhost:3000/api/health | jq
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/
```

Health reports `degraded` until data is loaded — that is the next section.

## Loading data

### The location layer — required

Nothing appears on the map until this runs. ~6 minutes; it streams a large WFS
layer (~940,000 features covering ~2,600 locations).

```sh
cd /opt/rws
sudo -u rws node packages/server/dist/cli/refresh.js
```

With `ENABLE_SCHEDULES=true` this then repeats daily on its own.

### History — optional

See [Loading history](../README.md#loading-history) in the README for the full
picture, including how to pull only the last few days versus a full year.

## Putting it behind a reverse proxy

The app speaks plain HTTP and trusts `X-Forwarded-*`, so it expects a proxy in
front. With nginx:

```nginx
server {
    listen 80;
    server_name example.org;

    location / {
        # Must match PORT in .env.
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```sh
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d example.org      # TLS, renewing itself
```

Then bind the app to localhost only, so nothing reaches it except through nginx —
set `HOST=127.0.0.1` in `.env` and restart. If the machine is exposed directly:

```sh
sudo ufw allow 80,443/tcp && sudo ufw enable
```

Before exposing it publicly, also read
[Before you expose it publicly](../README.md#before-you-expose-it-publicly).

## Operating it

```sh
systemctl status rws-api
journalctl -u rws-api -f                  # follow logs
sudo systemctl restart rws-api
curl -s localhost:3000/api/health | jq    # upstream, cache age, counts, backfill
```

**Upgrading:**

```sh
cd /opt/rws
sudo -u rws git pull
npm ci && npm run build && npm run build:web
sudo systemctl restart rws-api            # migrations run automatically on start
```

**Backups.** Ordinary PostgreSQL tooling applies. Note that `pg_dump` of a large
hypertable is slow and large; for anything past a few million rows prefer a
physical backup or `pg_basebackup`.

```sh
sudo -u postgres pg_dump -Fc rws > rws-$(date +%F).dump
```

The observation data is all re-downloadable from Rijkswaterstaat, so the
backfill queue itself is not precious — losing it costs download time, not data.

## Troubleshooting

### `apt install nodejs` gave me Node 18 and the app will not start

Ubuntu's archive carries 18.x; this app needs >= 20. Install from NodeSource as
in [step 1](#1-nodejs).

### `You need to install postgresql-server-dev-NN ... or libpq-dev`

`postgresql-common` provides `/usr/bin/pg_config` as a shim that forwards to a
real one under `/usr/lib/postgresql/*/bin/`. On a machine with no PostgreSQL
installed the shim exists but has nothing to forward to, so running it prints
this and exits 1 — which is confusing, because it reads like a missing build
dependency when nothing is being built.

Nothing here needs `postgresql-server-dev-*` or `libpq-dev`; the server is
installed from packages, and `pg` talks to it over TCP. If you hit this from
the installer, update to a build that contains this fix — it detects the
installed server by probing `/usr/lib/postgresql/` rather than by calling
`pg_config`. To check by hand what is actually installed:

```sh
ls -d /usr/lib/postgresql/*/ 2>/dev/null || echo "no PostgreSQL server installed"
pg_lsclusters
```

### `Package 'postgresql-16' has no installation candidate`

Ubuntu's own archive carries only one PostgreSQL major per release, and it is
not always the one being asked for. Add PGDG, which carries all of them:

```sh
sudo apt-get install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt-get update
```

Then retry. To see what your release can actually install:

```sh
apt-cache search '^postgresql-[0-9]+$'
apt-cache search timescaledb-2-postgresql
```

Pick a major that appears in *both* lists and pass it as `--pg-major`.

### `could not open extension control file ... timescaledb.control`

The extension package is not installed for the PostgreSQL major version you are
connecting to. Check both:

```sh
pg_config --version
dpkg -l | grep timescaledb-2-postgresql
```

### `FATAL: extension "timescaledb" must be preloaded`

`shared_preload_libraries` does not include `timescaledb`, or PostgreSQL has not
been restarted since it was added. `timescaledb-tune` sets it; the restart is
separate:

```sh
grep shared_preload_libraries /etc/postgresql/16/main/postgresql.conf
sudo systemctl restart postgresql
```

### `password authentication failed for user "postgres"`

The configuration fell back to its built-in default, which means `DATABASE_URL`
was not picked up. Check that `.env` exists, that it contains `DATABASE_URL`,
and that the process can read it (it is mode 0640, owned `root:rws`). Confirm
what the app actually resolves:

```sh
node -e "import('./packages/server/dist/env.js').then(m => console.log(m.loadedEnvFile))"
```

### `permission denied to create database` when running `npm test`

The integration suite creates a throwaway database per run:

```sh
sudo -u postgres psql -c "ALTER ROLE rws CREATEDB"
```

This is only needed for tests. A production role should not have it.

### `npm test` says `29 skipped` and exits green

The integration tests skip themselves when no database is reachable, which makes
a green run meaningless. They read `TEST_DATABASE_URL` from `.env`; set it to an
instance whose role may `CREATEDB`, then confirm the count is 89 passing rather
than 60 passing and 29 skipped.

### The app starts but `/api/health` reports upstream unreachable

Check the machine can reach Rijkswaterstaat at all:

```sh
curl -sI "https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/ows?service=WFS&request=GetCapabilities" | head -1
```

If your network requires an outbound proxy, note that Node's `fetch` ignores
`HTTPS_PROXY` unless told otherwise. Set both in `.env`:

```ini
NODE_USE_ENV_PROXY=1
HTTPS_PROXY=http://proxy.example.internal:3128
```

### `System has not been booted with systemd as init system`

You are in a container or chroot. The install script detects this and skips the
unit files; run the API directly instead:

```sh
node packages/server/dist/index.js
```

### PostgreSQL and MariaDB are fighting for memory

Both were tuned as if each owned the machine. Re-tune PostgreSQL with an
explicit budget and restart:

```sh
sudo timescaledb-tune --quiet --yes --memory 4GB
sudo systemctl restart postgresql
```

Then check MariaDB's `innodb_buffer_pool_size` adds up to something sane
alongside it.

## Uninstalling

```sh
sudo systemctl disable --now rws-api rws-backfill
sudo rm /etc/systemd/system/rws-api.service /etc/systemd/system/rws-backfill.service
sudo systemctl daemon-reload
sudo -u postgres psql -c "DROP DATABASE rws"
sudo -u postgres psql -c "DROP ROLE rws"
sudo deluser --system rws
sudo rm -rf /opt/rws
```

Leave PostgreSQL and TimescaleDB in place if anything else uses them.
