#!/usr/bin/env bash
# [owner] Object Lock prune check (issue #16 P1b; A§11.3, ADR-0011): the VPS
# key cannot remove object versions, so a compromised VPS cannot erase history.
#
# It never touches the live repository. On a throwaway prefix of the same bucket
# (lockcheck-<UTC time>/, which Object Lock keeps for its retention period, a few
# kilobytes), with the VPS key from /etc/rws/secrets/s3_credentials:
#   1. restic init, two backups of a tiny generated file, then
#      `restic forget --keep-last 1 --prune` (restic "deletes" packs);
#   2. over the S3 API (curl --aws-sigv4, the key on stdin, never argv):
#      every object version written in step 1 is still listed;
#      a DELETE of one version (by versionId) is refused;
#      shortening that version's retention is refused.
# Exit 0 only when all three hold. Output: counts and PASS/FAIL, no key.
#
# Usage (root, on the VPS, once the bucket and keys exist; owner action A5):
#   deploy/tests/object-lock-prune.sh [--dry-run]
set -euo pipefail
# shellcheck source=deploy/bin/rws-lib.sh
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../bin/rws-lib.sh"

case ${1:-} in
  --dry-run) DRY_RUN=1 ;;
  '') ;;
  *)
    echo "usage: object-lock-prune.sh [--dry-run]" >&2
    exit 64
    ;;
esac

load_env || die "no $RWS_ETC/rws.env"
[[ ${RWS_RESTIC_REPOSITORY:-} =~ ^s3:https://([a-z0-9.-]+(:[0-9]{1,5})?)/([a-z0-9._-]+)(/.*)?$ ]] ||
  die "RWS_RESTIC_REPOSITORY must look like s3:https://<host>/<bucket>[/<prefix>]"
endpoint=${BASH_REMATCH[1]} bucket=${BASH_REMATCH[3]}
host=${endpoint%%:*}
region=${RWS_S3_REGION:-us-east-1}
prefix=lockcheck-$(date -u +%Y%m%dT%H%M%SZ)
repo=s3:https://$endpoint/$bucket/$prefix
if ((DRY_RUN)); then
  log "dry-run: would init, back up twice and prune $repo with the VPS key, then check its object versions"
  exit 0
fi
[[ -e $RWS_STATE_DIR/active ]] || die "no release is deployed yet (the backup image comes from it)"

creds=$RWS_ETC/secrets/s3_credentials
key_id=$(awk -F' *= *' '$1 == "aws_access_key_id" { print $2; exit }' "$creds")
secret_key=$(awk -F' *= *' '$1 == "aws_secret_access_key" { print $2; exit }' "$creds")
[[ -n $key_id && -n $secret_key ]] || die "no key in $creds"

# s3 <method> <path+query> [curl args...]: path-style request signed with the VPS key.
s3() {
  local method=$1 path=$2
  shift 2
  printf 'user = "%s:%s"\naws-sigv4 = "aws:amz:%s:s3"\n' "$key_id" "$secret_key" "$region" |
    curl -K - --proto '=https' -sS --max-time 60 -X "$method" "$@" "https://$endpoint/$bucket$path"
}

allow_bucket "$host"
data=$RWS_SRV/backup/drill/lockcheck
trap 'rm -rf -- "$data"' EXIT
mkdir -p "$data"
restic() { rws_compose run --rm --no-deps -T -e "RESTIC_REPOSITORY=$repo" backup "$@" >/dev/null; }

log "throwaway repository $repo"
head -c 4096 /dev/urandom >"$data/a"
chmod -R a+rX "$data"
restic init || die "restic init failed"
restic backup --host lockcheck /restore/lockcheck || die "first backup failed"
head -c 4096 /dev/urandom >"$data/a"
restic backup --host lockcheck /restore/lockcheck || die "second backup failed"

# One <Key>/<VersionId> pair per version element (the S3 XML is flat enough for this).
list=$(s3 GET "?versions&prefix=$prefix/" | sed 's#<Version>#\n<Version>#g' | grep '^<Version>')
before=$(grep -c . <<<"$list" || true)
((before > 0)) || die "listing the object versions failed (does the key have s3:ListBucketVersions?)"

restic forget --host lockcheck --keep-last 1 --prune || log "restic forget --prune reported an error (expected with Object Lock)"

after_list=$(s3 GET "?versions&prefix=$prefix/" | sed 's#<Version>#\n<Version>#g' | grep '^<Version>')
missing=0
while IFS= read -r v; do
  id=$(grep -o '<VersionId>[^<]*' <<<"$v" | cut -d'>' -f2)
  grep -qF "<VersionId>$id</VersionId>" <<<"$after_list" || missing=$((missing + 1))
done <<<"$list"

one=$(head -n 1 <<<"$list")
okey=$(grep -o '<Key>[^<]*' <<<"$one" | cut -d'>' -f2)
ovid=$(grep -o '<VersionId>[^<]*' <<<"$one" | cut -d'>' -f2)
[[ $okey == "$prefix/"* && $ovid =~ ^[A-Za-z0-9._-]+$ ]] || die "unexpected object listing"
del=$(s3 DELETE "/$okey?versionId=$ovid" -o /dev/null -w '%{http_code}')
retention='<Retention><Mode>COMPLIANCE</Mode><RetainUntilDate>'$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)'</RetainUntilDate></Retention>'
md5=$(printf '%s' "$retention" | openssl dgst -md5 -binary | base64)
ret=$(s3 PUT "/$okey?retention&versionId=$ovid" -H "Content-MD5: $md5" -H 'Content-Type: application/xml' \
  --data-raw "$retention" -o /dev/null -w '%{http_code}')

fails=0
if ((missing == 0)); then echo "PASS all $before object versions survive restic forget --prune"; else
  echo "FAIL $missing of $before object versions were removed"
  fails=1
fi
if [[ $del == 403 || $del == 400 ]]; then echo "PASS deleting a version with the VPS key is refused (HTTP $del)"; else
  echo "FAIL deleting a version answered HTTP $del"
  fails=1
fi
if [[ $ret == 403 || $ret == 400 ]]; then echo "PASS shortening a retention with the VPS key is refused (HTTP $ret)"; else
  echo "FAIL shortening a retention answered HTTP $ret"
  fails=1
fi
((fails == 0))
