#!/usr/bin/env bash
# bootstrap.sh: sets up (and later re-checks) the Debian 13 VPS for the rws
# stack (A§11, A§12.2; issue #16 P1b). Idempotent: every step checks first and
# changes only what differs, so a second run reports 0 changes.
#
# Run it as root from a VERIFIED release bundle, never from a git checkout on
# the VPS (docs/runbooks/bootstrap.md: fetch the release, cosign verify-blob,
# check the bundle sha256, extract, run). It installs the host files from the
# bundle it runs from.
#
# Usage: sudo deploy/host/bootstrap.sh [--dry-run]
#   --dry-run  report what would change; change nothing
set -euo pipefail

bundle=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)
# shellcheck source=deploy/bin/rws-lib.sh
. "$bundle/deploy/bin/rws-lib.sh"
umask 022

readonly DOCKER_VERSION=29.8.1
readonly DOCKER_APT_VERSION=5:29.8.1-1~debian.13~trixie
readonly COMPOSE_VERSION=5.5.1
readonly COMPOSE_APT_VERSION=5.5.1-1~debian.13~trixie
readonly CONTAINERD_VERSION=2.3.5
readonly CONTAINERD_APT_VERSION=2.3.5-1~debian.13~trixie
# sha256 of https://download.docker.com/linux/debian/gpg (fingerprint 9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88)
readonly DOCKER_KEY_SHA256=1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570
readonly COSIGN_VERSION=v3.1.3
readonly COSIGN_SHA256=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71
readonly LIB=/usr/local/lib/rws
# Secret groups: a file secret keeps its host owner in the container, so each is
# root:<gid> 0440 and only its consumer gets that gid (compose.yaml group_add).
# The db_* passwords (P2a): db (the superuser's, read by initdb only), migrate,
# load and api; db_rws_publish and db_rws_owner_api have no consumer before P9.
readonly -A SECRET_GID=(['hc_ping_key']=61001 ['rws_x_api_key']=61002 ['restic_password']=61003 ['s3_credentials']=61003
  ['db_postgres']=61004 ['db_rws_migrator']=61005 ['db_rws_load']=61006 ['db_rws_publish']=61007
  ['db_rws_api']=61008 ['db_rws_owner_api']=61009)
readonly -A GROUP_GID=(['rws-hc']=61001 ['rws-rwskey']=61002 ['rws-backup']=61003
  ['rws-dbpostgres']=61004 ['rws-dbmigrator']=61005 ['rws-dbload']=61006 ['rws-dbpublish']=61007
  ['rws-dbapi']=61008 ['rws-dbownerapi']=61009)
readonly DB_SECRETS=(db_postgres db_rws_migrator db_rws_load db_rws_publish db_rws_api db_rws_owner_api)

case ${1:-} in
  --dry-run) DRY_RUN=1 ;;
  '') ;;
  *)
    echo "usage: bootstrap.sh [--dry-run]" >&2
    exit 64
    ;;
esac

changes=0
ok() { printf 'ok       %s\n' "$*"; }
# fix <what> <command...>: counts a change; runs the command unless --dry-run.
fix() {
  local what=$1
  shift
  changes=$((changes + 1))
  if ((DRY_RUN)); then
    printf 'would    %s\n' "$what"
  else
    "$@"
    printf 'changed  %s\n' "$what"
  fi
}
# install_file <src> <dest> <mode> [uid] [gid]: returns 0 when it changed (or would).
install_file() {
  local src=$1 dest=$2 mode=$3 uid=${4:-0} gid=${5:-0}
  if [[ -f $dest ]] && cmp -s "$src" "$dest" && [[ $(stat -c '%a %u %g' "$dest") == "${mode#0} $uid $gid" ]]; then
    ok "$dest"
    return 1
  fi
  fix "$dest" install -D -m "$mode" -o "$uid" -g "$gid" "$src" "$dest"
}
ensure_dir() {
  local dir=$1 mode=$2 uid=$3 gid=$4
  if [[ -d $dir && $(stat -c '%a %u %g' "$dir") == "${mode#0} $uid $gid" ]]; then
    ok "$dir"
  else
    fix "$dir ($mode $uid:$gid)" install -d -m "$mode" -o "$uid" -g "$gid" "$dir"
  fi
}
apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@"
}
enable_now() {
  local unit=$1
  if systemctl is-enabled --quiet "$unit" 2>/dev/null && systemctl is-active --quiet "$unit"; then
    ok "$unit enabled and active"
  else
    fix "$unit enabled and started" systemctl enable --now --quiet "$unit"
  fi
}
# A oneshot that runs at boot: enabled, never "active" afterwards.
enable_only() {
  if systemctl is-enabled --quiet "$1" 2>/dev/null; then ok "$1 enabled"; else fix "$1 enabled" systemctl enable --quiet "$1"; fi
}

# ------------------------------------------------------------------ preflight
((EUID == 0)) || die "run as root (sudo)"
# shellcheck source=/dev/null
. /etc/os-release
[[ ${ID:-} == debian && ${VERSION_CODENAME:-} == trixie ]] || die "Debian 13 (trixie) only"
[[ $(dpkg --print-architecture) == amd64 ]] || die "amd64 only (the images are linux/amd64)"
[[ -f $bundle/deploy/compose.yaml && -f $bundle/deploy/bin/rws-lib.sh ]] || die "not a release bundle: $bundle"
[[ $(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || true) == Y ]] ||
  die "AppArmor is not enabled in the kernel (A§12.2); enable it before running bootstrap"
echo "bootstrap from $bundle$( ((DRY_RUN)) && echo ' (dry run)')"

# ------------------------------------------------------------------ packages
packages=(ca-certificates curl jq zstd chrony unattended-upgrades needrestart apparmor apparmor-utils nftables sudo openssh-server)
missing=()
for p in "${packages[@]}"; do
  dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || missing+=("$p")
done
if ((${#missing[@]})); then fix "packages: ${missing[*]}" apt_install "${missing[@]}"; else ok "packages"; fi

if [[ $(timedatectl show -p Timezone --value 2>/dev/null || true) == UTC ]]; then
  ok "time zone UTC"
else
  fix "time zone UTC" timedatectl set-timezone UTC
fi

# ------------------------------------------------------------------ ops, SSH
if id ops >/dev/null 2>&1; then
  ok "user ops"
else
  # '*' = no password (not '!', which OpenSSH may treat as a locked account).
  fix "user ops" useradd --create-home --shell /bin/bash --password '*' ops
fi
keys=/home/ops/.ssh/authorized_keys
if [[ -s $keys ]]; then
  ok "$keys"
else
  # The keys of the user who ran sudo, else root's; a command="…" key (cloud
  # images: "Please login as the user …") would only run that command.
  from=/root/.ssh/authorized_keys
  if [[ -n ${SUDO_USER:-} && $SUDO_USER != root ]]; then
    home=$(getent passwd "$SUDO_USER" | cut -d: -f6 || true)
    [[ -z $home || ! -s $home/.ssh/authorized_keys ]] || from=$home/.ssh/authorized_keys
  fi
  usable=$(grep -Ev '^[[:space:]]*(#|$)' "$from" 2>/dev/null | grep -v 'command=' || true)
  if [[ -z $usable ]]; then
    msg="ops has no SSH key and $from holds no usable one (command= keys left out): add one to $keys first (bootstrap refuses to lock SSH)"
    if ((DRY_RUN)); then printf 'would    stop: %s\n' "$msg"; else die "$msg"; fi
  else
    copy_keys() {
      local tmp
      tmp=$(mktemp)
      printf '%s\n' "$usable" >"$tmp"
      install -d -m 0700 -o ops -g ops /home/ops/.ssh && install -m 0600 -o ops -g ops "$tmp" "$keys"
      rm -f -- "$tmp"
    }
    fix "$keys (the keys of $from without command= keys)" copy_keys
  fi
fi
T_SUDO=$(mktemp)
printf '# rws host (issue #16 P1b; owner decision 2026-09-29): ops administers the VPS with sudo.\nops ALL=(ALL) NOPASSWD: ALL\n' >"$T_SUDO"
visudo -cqf "$T_SUDO" || die "sudoers drop-in does not parse"
install_file "$T_SUDO" /etc/sudoers.d/90-rws-ops 0440 || true
rm -f -- "$T_SUDO"
if install_file "$bundle/deploy/host/sshd-rws.conf" /etc/ssh/sshd_config.d/10-rws.conf 0644 && ((!DRY_RUN)); then
  if ! /usr/sbin/sshd -t; then
    rm -f /etc/ssh/sshd_config.d/10-rws.conf
    die "sshd -t rejected the drop-in; removed it again"
  fi
  systemctl reload ssh
fi

# ------------------------------------------------------------------ system
if install_file "$bundle/deploy/host/sysctl-rws.conf" /etc/sysctl.d/90-rws.conf 0644 && ((!DRY_RUN)); then
  sysctl -q -p /etc/sysctl.d/90-rws.conf
fi
# Docker enables IPv6 forwarding, and a forwarding host ignores router
# advertisements unless accept_ra is 2: keep the RA route of the uplink.
uplink=$(ip -6 route show default 2>/dev/null | awk '/proto ra/ { for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
if [[ -n $uplink ]]; then
  ra=$(mktemp)
  printf '# rws host: keep the IPv6 router-advertised route on %s while Docker forwards.\nnet.ipv6.conf.%s.accept_ra = 2\n' "$uplink" "$uplink" >"$ra"
  if install_file "$ra" /etc/sysctl.d/91-rws-ra.conf 0644 && ((!DRY_RUN)); then sysctl -q -p /etc/sysctl.d/91-rws-ra.conf; fi
  rm -f -- "$ra"
fi
install_file "$bundle/deploy/host/apt-unattended-rws.conf" /etc/apt/apt.conf.d/52rws-unattended 0644 || true
install_file "$bundle/deploy/host/needrestart-rws.conf" /etc/needrestart/conf.d/rws.conf 0644 || true
enable_now chrony.service
enable_now unattended-upgrades.service

# ------------------------------------------------------------------ groups, directories, secrets
for group in "${!GROUP_GID[@]}"; do
  gid=${GROUP_GID[$group]}
  cur=$(getent group "$group" | cut -d: -f3 || true)
  if [[ $cur == "$gid" ]]; then
    ok "group $group ($gid)"
  elif [[ -n $cur ]]; then
    die "group $group exists with gid $cur, expected $gid"
  elif getent group "$gid" >/dev/null; then
    die "gid $gid is already taken"
  else
    fix "group $group ($gid)" groupadd --system --gid "$gid" "$group"
  fi
done

ensure_dir /etc/rws 0755 0 0
ensure_dir /etc/rws/secrets 0700 0 0
ensure_dir /var/lib/rws 0700 0 0
ensure_dir /var/lib/rws/releases 0700 0 0
ensure_dir /srv/rws 0755 0 0
ensure_dir /srv/rws/raw 0750 65532 65532
ensure_dir /srv/rws/public 0755 0 0
ensure_dir /srv/rws/public/status 0755 65532 65532
ensure_dir /srv/rws/public/ops 0755 0 0
ensure_dir /srv/rws/owner 0750 65532 65532
ensure_dir /srv/rws/owner/status 0750 65532 65532
ensure_dir /srv/rws/tiles 0755 0 0
# Root's: the backup job mounts only the subdirectories below, and an owner of the parent could swap db/ for a
# link under root's nightly dump (nothing writes the parent itself).
ensure_dir /srv/rws/backup 0700 0 0
ensure_dir /srv/rws/backup/cache 0700 65532 65532
ensure_dir /srv/rws/backup/drill 0700 65532 65532
# The nightly database dump: written by root (rws-backup), read by the backup job (gid 61003).
ensure_dir /srv/rws/backup/db 0750 0 61003

for name in "${!SECRET_GID[@]}"; do
  file=/etc/rws/secrets/$name gid=${SECRET_GID[$name]}
  if [[ -f $file && $(stat -c '%a %u %g' "$file") == "440 0 $gid" ]]; then
    ok "$file"
  elif [[ -f $file ]]; then
    fix "$file (root:$gid 0440)" chown "0:$gid" "$file"
    ((DRY_RUN)) || chmod 0440 "$file"
  else
    fix "$file (empty until the owner fills it)" install -m 0440 -o 0 -g "$gid" /dev/null "$file"
  fi
done
# The RWS X-API-KEY is a stable value of our own choosing (catalogue §2.1); never overwritten.
if [[ -s /etc/rws/secrets/rws_x_api_key ]]; then
  ok "rws_x_api_key present"
else
  gen_key() { cat /proc/sys/kernel/random/uuid >/etc/rws/secrets/rws_x_api_key; }
  fix "rws_x_api_key generated" gen_key
fi
# The database passwords: 32 bytes of the kernel CSPRNG as 64 lowercase hex
# characters, written in place (the file keeps root:<gid> 0440) only while the
# file is empty; never overwritten, never printed. rws-lib.sh (db_prepare)
# refuses any other format, so a malformed one stops here first.
gen_db_secret() {
  local hex
  hex=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
  [[ $hex =~ $RWS_HEX64_RE ]] || die "could not read 32 random bytes"
  printf '%s\n' "$hex" >"$1"
}
for name in "${DB_SECRETS[@]}"; do
  file=/etc/rws/secrets/$name
  if [[ ! -s $file ]]; then
    fix "$name generated" gen_db_secret "$file"
  elif [[ $(secret "$name" || true) =~ $RWS_HEX64_RE ]]; then
    ok "$name present"
  else
    msg="$file does not hold 64 lowercase hex characters: empty it (: >$file), run bootstrap again, then rws-deploy the current release"
    if ((DRY_RUN)); then printf 'would    stop: %s\n' "$msg"; else die "$msg"; fi
  fi
done

# The db service's pg_hba.conf and pg_ident.conf at an absolute path (compose.yaml
# mounts /etc/rws/postgres read-only; a release directory is replaced on every
# deploy). World-readable: uid 999 in the container reads them; no secret in them.
ensure_dir /etc/rws/postgres 0755 0 0
pg_conf_changed=0
for f in pg_hba.conf pg_ident.conf; do
  install_file "$bundle/deploy/postgres/$f" "/etc/rws/postgres/$f" 0644 && pg_conf_changed=1
done
# A running db reads them again on SIGHUP (the postmaster is its PID 1).
if ((pg_conf_changed && !DRY_RUN)) &&
  [[ $(docker inspect -f '{{.State.Running}}' rws-db-1 2>/dev/null || true) == true ]]; then
  docker kill --signal HUP rws-db-1 >/dev/null && echo "changed  db reloaded its pg_hba.conf and pg_ident.conf"
fi

if [[ -f /etc/rws/rws.env ]]; then
  ok "/etc/rws/rws.env (the owner's settings are never overwritten)"
else
  src4=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')
  src6=$(ip -6 route get 2606:4700:4700::1111 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')
  write_env() {
    cat >/etc/rws/rws.env <<EOF
# Host settings of the rws stack (docs/runbooks/bootstrap.md). No secrets here:
# those are files in /etc/rws/secrets. Plain KEY=VALUE lines, no quotes.
# Written once by bootstrap.sh from what the host reports; check every line.
RWS_DOMAIN=
RWS_CONTACT_EMAIL=
RWS_PUBLIC_IPV4=${src4}
RWS_PUBLIC_IPV6=${src6}
RWS_RESTIC_REPOSITORY=
RWS_S3_REGION=
RWS_BACKUP=off
EOF
    chmod 0644 /etc/rws/rws.env
  }
  fix "/etc/rws/rws.env (template; public addresses detected: ${src4:-none} ${src6:-none})" write_env
fi

# ------------------------------------------------------------------ host scripts from this bundle
if [[ -d $LIB/deploy ]] && diff -rq "$bundle/deploy" "$LIB/deploy" >/dev/null 2>&1; then
  ok "$LIB/deploy"
else
  copy_bundle() {
    install -d -m 0755 "$LIB"
    rm -rf -- "$LIB/deploy.new"
    cp -r "$bundle/deploy" "$LIB/deploy.new"
    chown -R 0:0 "$LIB/deploy.new"
    chmod -R go-w "$LIB/deploy.new"
    rm -rf -- "$LIB/deploy.old"
    [[ ! -d $LIB/deploy ]] || mv -T "$LIB/deploy" "$LIB/deploy.old"
    mv -T "$LIB/deploy.new" "$LIB/deploy"
    rm -rf -- "$LIB/deploy.old"
  }
  fix "$LIB/deploy (host scripts, units and settings of this bundle)" copy_bundle
fi
for script in "$bundle"/deploy/bin/rws-*; do
  name=${script##*/}
  [[ $name != *.sh ]] || continue
  if [[ $(readlink "/usr/local/bin/$name" 2>/dev/null || true) == "$LIB/deploy/bin/$name" ]]; then
    ok "/usr/local/bin/$name"
  else
    fix "/usr/local/bin/$name" ln -sfn "$LIB/deploy/bin/$name" "/usr/local/bin/$name"
  fi
done
# ------------------------------------------------------------------ firewall
if [[ $(systemctl is-enabled nftables.service 2>/dev/null || true) == masked ]]; then
  ok "nftables.service masked"
else
  # Its ExecStop is `nft flush ruleset`: stopping it removes Docker's rules too.
  mask_nftables() {
    local docker_up=0
    systemctl is-active --quiet docker.service && docker_up=1
    systemctl disable --now --quiet nftables.service 2>/dev/null || true
    systemctl mask --quiet nftables.service
    ((docker_up == 0)) || systemctl restart docker.service
  }
  fix "nftables.service masked (rws-firewall.service replaces it)" mask_nftables
fi
# Never install a ruleset that does not load: docker.service Requires= the firewall.
if ((!DRY_RUN)) || command -v nft >/dev/null 2>&1; then
  nft -c -f "$bundle/deploy/host/nftables.conf" || die "deploy/host/nftables.conf does not pass nft -c: nothing installed"
fi
fw_changed=0
install_file "$bundle/deploy/host/nftables.conf" /etc/rws/nftables.conf 0644 && fw_changed=1
units_changed=0
for unit in "$bundle"/deploy/systemd/*; do
  install_file "$unit" "/etc/systemd/system/${unit##*/}" 0644 && units_changed=1
done
install_file "$bundle/deploy/host/docker-rws.conf" /etc/systemd/system/docker.service.d/10-rws.conf 0644 && units_changed=1
if ((units_changed && !DRY_RUN)); then systemctl daemon-reload; fi
enable_now rws-firewall.service
if ((fw_changed && !DRY_RUN)); then systemctl reload rws-firewall.service; fi
enable_now rws-resolvers.path
enable_only rws-resolvers.service

# ------------------------------------------------------------------ Docker, Compose, cosign
ensure_dir /etc/docker 0755 0 0
docker_json_changed=0
install_file "$bundle/deploy/host/daemon.json" /etc/docker/daemon.json 0644 && docker_json_changed=1
if [[ -f /etc/apt/keyrings/docker.asc ]] &&
  echo "$DOCKER_KEY_SHA256  /etc/apt/keyrings/docker.asc" | sha256sum -c --quiet - >/dev/null 2>&1; then
  ok "Docker apt key (sha256 pinned)"
else
  docker_key() {
    local tmp
    tmp=$(mktemp)
    curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp" https://download.docker.com/linux/debian/gpg
    echo "$DOCKER_KEY_SHA256  $tmp" | sha256sum -c --quiet - || die "the Docker apt key does not match its pinned sha256"
    install -D -m 0644 "$tmp" /etc/apt/keyrings/docker.asc
    rm -f -- "$tmp"
  }
  fix "Docker apt key (sha256 pinned)" docker_key
fi
install_file "$bundle/deploy/host/docker.sources" /etc/apt/sources.list.d/docker.sources 0644 || true
declare -A want=(['docker-ce']=$DOCKER_APT_VERSION ['docker-ce-cli']=$DOCKER_APT_VERSION
  ['containerd.io']=$CONTAINERD_APT_VERSION ['docker-compose-plugin']=$COMPOSE_APT_VERSION)
pins=() stale=0
for pkg in "${!want[@]}"; do
  pins+=("$pkg=${want[$pkg]}")
  [[ $(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || true) == "${want[$pkg]}" ]] || stale=1
done
if ((stale)); then
  fix "Docker $DOCKER_VERSION, Compose $COMPOSE_VERSION, containerd $CONTAINERD_VERSION" \
    apt_install --allow-change-held-packages --allow-downgrades "${pins[@]}"
else
  ok "Docker $DOCKER_VERSION, Compose $COMPOSE_VERSION, containerd $CONTAINERD_VERSION"
fi
held=$(apt-mark showhold 2>/dev/null || true)
unheld=()
for pkg in "${!want[@]}"; do grep -qxF "$pkg" <<<"$held" || unheld+=("$pkg"); done
if ((${#unheld[@]})); then fix "held: ${unheld[*]}" apt-mark hold "${unheld[@]}"; else ok "Docker packages held"; fi
enable_now docker.service
if ((docker_json_changed && !DRY_RUN)); then systemctl restart docker.service; fi

if [[ -x /usr/local/bin/cosign ]] &&
  echo "$COSIGN_SHA256  /usr/local/bin/cosign" | sha256sum -c --quiet - >/dev/null 2>&1; then
  ok "cosign $COSIGN_VERSION"
else
  get_cosign() {
    local tmp
    tmp=$(mktemp)
    curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp" \
      "https://github.com/sigstore/cosign/releases/download/$COSIGN_VERSION/cosign-linux-amd64"
    echo "$COSIGN_SHA256  $tmp" | sha256sum -c --quiet - || die "cosign does not match its pinned sha256"
    install -m 0755 "$tmp" /usr/local/bin/cosign
    rm -f -- "$tmp"
  }
  fix "cosign $COSIGN_VERSION (sha256 pinned)" get_cosign
fi

# ------------------------------------------------------------------ status file, timers
if [[ -s /srv/rws/public/ops/ops.json ]]; then
  ok "/srv/rws/public/ops/ops.json"
else
  fix "/srv/rws/public/ops/ops.json" ops_update '.'
fi
for unit in rws-status-copy.path rws-update.timer rws-backup.timer rws-restore-drill.timer rws-tick.timer; do
  enable_now "$unit"
done

# ------------------------------------------------------------------ last: the installed host files
# What rws-update compares each release with (update_ok in rws-lib.sh). Only
# after every step above succeeded, so a bootstrap that stopped halfway never
# clears the drift signal.
sums=$(mktemp)
host_files "$bundle" >"$sums"
install_file "$sums" /var/lib/rws/host-files.sha256 0600 || true
rm -f -- "$sums"

echo "bootstrap: $changes change(s)$( ((DRY_RUN)) && echo ' would be made')"
