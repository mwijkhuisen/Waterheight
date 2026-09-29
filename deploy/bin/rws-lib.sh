# shellcheck shell=bash
# Shared helpers of the rws-* host scripts (issue #16 P1b; A§11.2, A§11.3).
# Sourced, never run. Every script runs as root from a systemd unit or by the
# owner with sudo. The paths can be moved for the offline tests
# (deploy/tests/*.test.sh); the signing identity and issuer cannot.
set -euo pipefail
umask 077
export LC_ALL=C

readonly RWS_IDENTITY='https://github.com/mwijkhuisen/Waterheight/.github/workflows/release.yml@refs/heads/main'
readonly RWS_ISSUER='https://token.actions.githubusercontent.com'
readonly RWS_TAG_RE='^prod-[0-9]{8}T[0-9]{6}Z$'
readonly RWS_HEX64_RE='^[0-9a-f]{64}$'
readonly RWS_PING_SLUGS='^(backup|restore-drill|update|watchdog|cert|disk)$'

RWS_STATE_DIR=${RWS_STATE_DIR:-/var/lib/rws}
RWS_ETC=${RWS_ETC:-/etc/rws}
RWS_SRV=${RWS_SRV:-/srv/rws}
RWS_LOCK_DIR=${RWS_LOCK_DIR:-/run/rws}
RWS_RELEASES_URL=${RWS_RELEASES_URL:-https://github.com/mwijkhuisen/Waterheight/releases}
RWS_STATUS_COPY=${RWS_STATUS_COPY:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/rws-status-copy}
export TUF_ROOT=${TUF_ROOT:-$RWS_STATE_DIR/sigstore}
DRY_RUN=${DRY_RUN:-0}

log() { printf '%s %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${0##*/}" "$*" >&2; }
die() {
  log "error: $*"
  exit 1
}
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# lockfile <name>: a lock in the root-only lock directory, never a shared 1777
# one such as /run/lock, where another user could pre-create the file.
lockfile() {
  mkdir -m 0700 -- "$RWS_LOCK_DIR" 2>/dev/null || [[ -d $RWS_LOCK_DIR ]]
  printf '%s/%s.lock' "$RWS_LOCK_DIR" "$1"
}

# stdin -> a temporary file in the destination's directory -> rename (atomic).
write_atomic() {
  local dest=$1 mode=${2:-0600} tmp
  tmp=$(mktemp "${dest%/*}/.${dest##*/}.XXXXXX")
  cat >"$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
}

# The host settings: KEY=VALUE lines of /etc/rws/rws.env, never sourced as shell.
load_env() {
  local file=$RWS_ETC/rws.env line
  [[ -r $file ]] || return 1
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    [[ $line =~ ^(RWS_[A-Z0-9_]+)=([^\"\'\`\$\\]*)$ ]] || die "rws.env: malformed line"
    printf -v "${BASH_REMATCH[1]}" '%s' "${BASH_REMATCH[2]}"
  done <"$file"
}

# True when the settings a deploy needs are present and well-formed (owner actions A2-A4).
env_ready() {
  load_env || return 1
  [[ ${RWS_DOMAIN:-} =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] &&
    [[ ${RWS_CONTACT_EMAIL:-} =~ ^[A-Za-z0-9._%+-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] &&
    [[ ${RWS_PUBLIC_IPV4:-} =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] &&
    [[ ${RWS_PUBLIC_IPV6:-} =~ ^[0-9a-f:]+$ && ${RWS_PUBLIC_IPV6:-} == *:* ]]
}

# The first line of a secret file, or failure when it is missing or empty.
secret() {
  local file=$RWS_ETC/secrets/$1 value
  [[ -s $file ]] || return 1
  IFS= read -r value <"$file" || [[ -n $value ]]
  value=${value%$'\r'}
  [[ -n $value ]] || return 1
  printf '%s' "$value"
}

# ping <slug> [start|fail] [code]: a healthchecks.io ping. The key reaches curl
# through a config on stdin, never argv; the body is a fixed code, never tool
# output (no path or source ID leaves the VPS this way).
ping() {
  local slug=$1 kind=${2:-} code=${3:-ok} key
  [[ $slug =~ $RWS_PING_SLUGS ]] || die "ping: unknown slug"
  [[ -z $kind || $kind == start || $kind == fail ]] || die "ping: unknown kind"
  [[ $code =~ ^[a-z0-9_]{1,40}$ ]] || code=other
  if ! key=$(secret hc_ping_key) || ! [[ $key =~ ^[A-Za-z0-9_-]{16,64}$ ]]; then
    log "no usable hc_ping_key: ping $slug${kind:+/$kind} not sent"
    return 0
  fi
  if ((DRY_RUN)); then
    log "dry-run: ping $slug${kind:+/$kind} ($code)"
    return 0
  fi
  printf 'url = "https://hc-ping.com/%s/%s%s"\n' "$key" "$slug" "${kind:+/$kind}" |
    curl -K - --proto '=https' -fsS --max-time 10 --retry 2 -o /dev/null --data-raw "$code" ||
    log "ping $slug${kind:+/$kind} failed"
}

# The state files (root-only): current = the last green release, skip_upto = the
# newest release that must not be auto-deployed again, active -> the running release.
state_get() {
  local file=$RWS_STATE_DIR/$1 value=''
  [[ -f $file ]] && IFS= read -r value <"$file"
  [[ -z $value || $value =~ $RWS_TAG_RE ]] || die "state file $1 is corrupt"
  printf '%s' "$value"
}
state_set() { printf '%s\n' "$2" | write_atomic "$RWS_STATE_DIR/$1" 0600; }
set_active() {
  ln -sfn "releases/$1" "$RWS_STATE_DIR/.active.new"
  mv -Tf "$RWS_STATE_DIR/.active.new" "$RWS_STATE_DIR/active"
}
# Fixed-format tags compare as strings (LC_ALL=C).
tag_newer() { [[ $1 > $2 ]]; }
max_tag() { if tag_newer "$1" "$2"; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
tag_epoch() {
  local t=$1
  date -u -d "${t:5:4}-${t:9:2}-${t:11:2}T${t:14:2}:${t:16:2}:${t:18:2}Z" +%s
}

# docker compose on a release directory (default: the active one), as project "rws".
rws_compose() {
  local dir=$RWS_STATE_DIR/active
  if [[ ${1:-} == --release ]]; then
    dir=$RWS_STATE_DIR/releases/$2
    shift 2
  fi
  docker compose -p rws --project-directory "$dir" -f "$dir/compose.yaml" \
    --env-file "$RWS_ETC/rws.env" --env-file "$dir/images.env" "$@"
}

# https only, no redirect to http, size-capped.
fetch() {
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 2 --max-time 300 \
    --max-filesize "$3" -o "$2" "$1"
}

# fetch_manifest <latest|tag> <dir>: the manifest and its sigstore bundle.
fetch_manifest() {
  local base
  if [[ $1 == latest ]]; then base=$RWS_RELEASES_URL/latest/download; else base=$RWS_RELEASES_URL/download/$1; fi
  fetch "$base/release-manifest.json" "$2/release-manifest.json" 65536 &&
    fetch "$base/release-manifest.sigstore.json" "$2/release-manifest.sigstore.json" 1048576
}

# verify_manifest <dir> [expected tag]: the signature first, then a strict parse.
# Prints the tag. Nothing from the file is used before cosign accepted it.
verify_manifest() {
  local dir=$1 want=${2:-} tag
  cosign verify-blob --bundle "$dir/release-manifest.sigstore.json" \
    --certificate-identity "$RWS_IDENTITY" --certificate-oidc-issuer "$RWS_ISSUER" \
    "$dir/release-manifest.json" >/dev/null 2>&1 || {
    log "release manifest: signature not valid for $RWS_IDENTITY"
    return 1
  }
  jq -e '
    (keys == ["bundle", "commit", "images", "tag", "version"]) and .version == 1
    and (.tag | type == "string" and test("^prod-[0-9]{8}T[0-9]{6}Z$"))
    and (.commit | type == "string" and test("^[0-9a-f]{40}$"))
    and (.images | type == "object" and keys == ["backup", "server", "web"])
    and all(.images | to_entries[]; .key as $k
      | .value | type == "string" and test("^ghcr\\.io/mwijkhuisen/waterheight/" + $k + "@sha256:[0-9a-f]{64}$"))
    and (.bundle | type == "object" and keys == ["name", "sha256"])
    and .bundle.name == "deploy-bundle.tar.gz"
    and (.bundle.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
  ' "$dir/release-manifest.json" >/dev/null 2>&1 || {
    log "release manifest: unexpected format"
    return 1
  }
  tag=$(jq -r .tag "$dir/release-manifest.json")
  [[ $tag =~ $RWS_TAG_RE ]] || return 1
  if [[ -n $want && $tag != "$want" ]]; then
    log "release manifest: tag $tag, expected $want"
    return 1
  fi
  if (($(tag_epoch "$tag") > $(date -u +%s) + 3600)); then
    log "release manifest: tag $tag lies in the future"
    return 1
  fi
  printf '%s' "$tag"
}

# verify_image <name@sha256:digest>: signed by exactly our release workflow.
verify_image() {
  [[ $1 =~ ^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$ ]] || {
    log "image reference not pinned by digest"
    return 1
  }
  cosign verify --certificate-identity "$RWS_IDENTITY" --certificate-oidc-issuer "$RWS_ISSUER" \
    "$1" >/dev/null 2>&1 || {
    log "image ${1%%@*}: no valid signature from $RWS_IDENTITY"
    return 1
  }
}

# The shared status file (served as /status/ops.json): exactly generated_at,
# last_backup, drill {at, sampled, matched} and disk_pct, updated under a lock.
# Usage: ops_update [jq options] '<filter>', e.g. ops_update --arg t "$now" '.last_backup = $t'
ops_update() {
  local file=$RWS_SRV/public/ops/ops.json filter=${*: -1}
  local -a opts=("${@:1:$#-1}")
  (
    flock -w 60 9 || die "ops.json lock busy"
    local current='{}' next
    [[ -s $file ]] && current=$(<"$file")
    jq -e 'type == "object"' <<<"$current" >/dev/null 2>&1 || current='{}'
    next=$(jq -c "${opts[@]}" --arg now "$(now_iso)" "($filter) | {
        generated_at: \$now, last_backup,
        drill: (.drill | if . == null then null else {at, sampled, matched} end), disk_pct}" <<<"$current") ||
      die "ops.json: update failed"
    jq -e '
      (.last_backup == null or (.last_backup | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$")))
      and (.disk_pct == null or (.disk_pct | type == "number" and . >= 0 and . <= 100))
      and (.drill == null or ((.drill.at | type == "string") and (.drill.sampled | type == "number")
        and (.drill.matched | type == "number")))
    ' <<<"$next" >/dev/null || die "ops.json: refusing an unexpected document"
    printf '%s\n' "$next" | write_atomic "$file" 0644
  ) 9>"$(lockfile rws-ops)"
}

# stage_release <dir> <tag>: with the manifest in <dir> already verified, fetch
# the deploy bundle, check it against the signed sha256, verify every image and
# write releases/<tag>/{compose.yaml,images.env,release-manifest.json,deploy/}.
stage_release() {
  local src=$1 tag=$2 want sum key ref stage old
  want=$(jq -r .bundle.sha256 "$src/release-manifest.json")
  [[ $want =~ $RWS_HEX64_RE ]] || return 1
  fetch "$RWS_RELEASES_URL/download/$tag/deploy-bundle.tar.gz" "$src/deploy-bundle.tar.gz" 20971520 || {
    log "release $tag: bundle download failed"
    return 1
  }
  sum=$(sha256sum "$src/deploy-bundle.tar.gz")
  [[ ${sum%% *} == "$want" ]] || {
    log "release $tag: bundle sha256 does not match the signed manifest"
    return 1
  }
  for key in server web backup; do
    ref=$(jq -r --arg k "$key" '.images[$k]' "$src/release-manifest.json")
    verify_image "$ref" || return 1
  done
  mkdir -p "$RWS_STATE_DIR/releases"
  stage=$(mktemp -d "$RWS_STATE_DIR/releases/.$tag.XXXXXX")
  if ! tar -xzf "$src/deploy-bundle.tar.gz" -C "$stage" --no-same-owner deploy ||
    ! [[ -f $stage/deploy/compose.yaml ]]; then
    rm -rf -- "$stage"
    log "release $tag: the bundle has no deploy/compose.yaml"
    return 1
  fi
  cp "$stage/deploy/compose.yaml" "$src/release-manifest.json" "$stage/"
  jq -r '"RWS_SERVER_IMAGE=\(.images.server)\nRWS_WEB_IMAGE=\(.images.web)\nRWS_BACKUP_IMAGE=\(.images.backup)"' \
    "$src/release-manifest.json" >"$stage/images.env"
  if [[ -e $RWS_STATE_DIR/releases/$tag ]]; then
    old=$(mktemp -u "$RWS_STATE_DIR/releases/.old.$tag.XXXXXX")
    mv -T "$RWS_STATE_DIR/releases/$tag" "$old"
    mv -T "$stage" "$RWS_STATE_DIR/releases/$tag"
    rm -rf -- "$old"
  else
    mv -T "$stage" "$RWS_STATE_DIR/releases/$tag"
  fi
}

# smoke <epoch>: /healthz answers 200 over real TLS and capture.json was written
# after <epoch> (taken once `up -d` returned), within RWS_SMOKE_TIMEOUT seconds.
# It publishes capture's newest file itself (rws-status-copy) before each try,
# so a deploy never depends on rws-status-copy.path.
smoke() {
  local t0=$1 deadline gen epoch resolve
  if ((${RWS_INJECT_SMOKE_FAILURE:-0})); then
    log "smoke test: failure injected (rws-deploy --inject-smoke-failure)"
    return 1
  fi
  resolve=$RWS_DOMAIN:443:$RWS_PUBLIC_IPV4
  deadline=$((SECONDS + ${RWS_SMOKE_TIMEOUT:-300}))
  while ((SECONDS < deadline)); do
    "$RWS_STATUS_COPY" >/dev/null || true
    if curl -fsS -o /dev/null --max-time 10 --resolve "$resolve" "https://$RWS_DOMAIN/healthz" 2>/dev/null &&
      gen=$(curl -fsS --max-time 10 --resolve "$resolve" "https://$RWS_DOMAIN/status/capture.json" 2>/dev/null |
        jq -r '.generated_at | strings') &&
      epoch=$(date -u -d "$gen" +%s 2>/dev/null) && ((epoch > t0)); then
      log "smoke test passed"
      return 0
    fi
    sleep "${RWS_SMOKE_INTERVAL:-10}"
  done
  log "smoke test failed: no /healthz 200 and fresh capture.json within ${RWS_SMOKE_TIMEOUT:-300} s"
  return 1
}

# host_files <dir>: the sha256 and path of every file under <dir>/deploy but
# compose.yaml, sorted, so a changed, added or removed file changes the list.
# bootstrap.sh records it for the files it installed (host-files.sha256).
host_files() {
  (cd "$1" && find deploy -type f ! -path deploy/compose.yaml -print0 | sort -z | xargs -0 -r sha256sum)
}

# The update check's success ping. Host files are installed only by bootstrap.sh
# (from a verified bundle), so while the active release brings others it pings
# /fail host_files_changed instead, on every run, until the owner re-runs it.
update_ok() {
  local act list=$RWS_STATE_DIR/host-files.sha256
  act=$(readlink "$RWS_STATE_DIR/active" 2>/dev/null || true)
  if [[ -f $list && -n $act && -d $RWS_STATE_DIR/$act/deploy ]] &&
    ! host_files "$RWS_STATE_DIR/$act" | cmp -s - "$list"; then
    log "release ${act#releases/} brings changed host files: run $RWS_STATE_DIR/$act/deploy/host/bootstrap.sh"
    ping update fail host_files_changed
  else
    ping update
  fi
}

# Keeps the 5 newest release directories (and current and active) and removes
# our images that none of them references.
cleanup_releases() {
  local cur act d ref
  cur=$(state_get current)
  act=$(readlink "$RWS_STATE_DIR/active" 2>/dev/null || true)
  act=${act#releases/}
  mapfile -t dirs < <(find "$RWS_STATE_DIR/releases" -mindepth 1 -maxdepth 1 -type d -name 'prod-*' -printf '%f\n' | sort -r)
  for d in "${dirs[@]:5}"; do
    [[ $d == "$cur" || $d == "$act" ]] || rm -rf -- "${RWS_STATE_DIR:?}/releases/$d"
  done
  docker image ls --digests --filter 'reference=ghcr.io/mwijkhuisen/waterheight/*' \
    --format '{{.Repository}}@{{.Digest}}' 2>/dev/null |
    while IFS= read -r ref; do
      [[ $ref == *@sha256:* ]] || continue
      grep -qsxF -e "RWS_SERVER_IMAGE=$ref" -e "RWS_WEB_IMAGE=$ref" -e "RWS_BACKUP_IMAGE=$ref" \
        "$RWS_STATE_DIR"/releases/*/images.env || docker image rm "$ref" >/dev/null 2>&1 || true
    done
}

# rollback <failed tag> <current tag or empty>: never returns.
rollback() {
  local tag=$1 cur=$2 skip t0
  # An injected failure (rws-deploy --inject-smoke-failure) is for the new release only.
  unset RWS_INJECT_SMOKE_FAILURE
  skip=$(state_get skip_upto)
  state_set skip_upto "$(max_tag "$tag" "$skip")"
  if [[ -z $cur || ! -d $RWS_STATE_DIR/releases/$cur ]]; then
    ping update fail first_deploy_failed
    die "deploy of $tag failed and there is no previous release: containers left as they are, $tag is not retried automatically (fix the cause, then rws-deploy $tag)"
  fi
  log "deploy of $tag failed: rolling back to $cur"
  set_active "$cur"
  if rws_compose up -d --remove-orphans && t0=$(date -u +%s) && smoke "$t0"; then
    ping update fail rolled_back
    die "deploy of $tag failed; rolled back to $cur"
  fi
  ping update fail rollback_failed
  die "deploy of $tag failed, and the rollback to $cur failed its smoke test too"
}

# deploy_release <dir with the verified manifest> <tag>: stage, pull by digest,
# up, smoke; the current pointer moves only after a green smoke test.
deploy_release() {
  local src=$1 tag=$2 cur t0
  if ! stage_release "$src" "$tag"; then
    ping update fail verify_failed
    die "release $tag not deployed: verification failed (nothing changed; retried next run)"
  fi
  if ! rws_compose --release "$tag" --profile jobs pull --quiet; then
    ping update fail pull_failed
    die "release $tag not deployed: pull failed (nothing changed; retried next run)"
  fi
  cur=$(state_get current)
  set_active "$tag"
  # t0 after `up`: the replaced capture container has stopped by then, so only
  # the running release can write a newer capture.json.
  if rws_compose up -d --remove-orphans && t0=$(date -u +%s) && smoke "$t0"; then
    state_set current "$tag"
    log "deployed $tag"
    cleanup_releases
    update_ok
    return 0
  fi
  rollback "$tag" "$cur"
}

# The backup settings (owner action A5): false while RWS_BACKUP is not "on";
# dies on a malformed repository; sets BUCKET_HOST from RWS_RESTIC_REPOSITORY
# (s3:https://<host>[:443]/<bucket>[/<prefix>]; the firewall lets the backup
# network reach port 443 only). Never call it in $(...).
backup_ready() {
  load_env || return 1
  [[ ${RWS_BACKUP:-off} == on ]] || return 1
  [[ ${RWS_RESTIC_REPOSITORY:-} =~ ^s3:https://([a-z0-9.-]+)(:443)?/[a-z0-9._-]+(/[A-Za-z0-9._/-]*)?$ ]] ||
    die "RWS_RESTIC_REPOSITORY must look like s3:https://<host>/<bucket>[/<prefix>] (port 443 only)"
  # shellcheck disable=SC2034 # read by the scripts that source this file
  BUCKET_HOST=${BASH_REMATCH[1]}
}

# allow_bucket <host>: the backup network may reach only these addresses (tcp/443).
# ponytail: the set holds what the host resolves now; a CDN that answers the
# container differently fails the run, which pings /fail (risk register).
allow_bucket() {
  local host=$1 batch v4 v6
  mapfile -t v4 < <(getent ahostsv4 "$host" | awk '{ print $1 }' | sort -u)
  mapfile -t v6 < <(getent ahostsv6 "$host" | awk '$1 !~ /^::ffff:/ { print $1 }' | sort -u)
  ((${#v4[@]} + ${#v6[@]} > 0)) || die "cannot resolve the bucket host"
  batch='flush set inet rws backup4'$'\n''flush set inet rws backup6'$'\n'
  ((${#v4[@]} == 0)) || batch+="add element inet rws backup4 { $(IFS=,; echo "${v4[*]}") }"$'\n'
  ((${#v6[@]} == 0)) || batch+="add element inet rws backup6 { $(IFS=,; echo "${v6[*]}") }"$'\n'
  printf '%s' "$batch" | nft -f -
}
