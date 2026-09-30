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
#      the bucket's default retention is COMPLIANCE for at least 30 days;
#      a version written in step 1 is retained in COMPLIANCE for >= 29 more days;
#      every object version written in step 1 is still listed;
#      a DELETE of one version (by versionId) is refused;
#      shortening that version's retention is refused.
# Exit 0 only when all five hold. Output: counts and PASS/FAIL, no key.
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
[[ ${RWS_RESTIC_REPOSITORY:-} =~ ^s3:https://([a-z0-9.-]+(:443)?)/([a-z0-9._-]+)(/.*)?$ ]] ||
  die "RWS_RESTIC_REPOSITORY must look like s3:https://<host>/<bucket>[/<prefix>] (port 443 only)"
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
# xml_value <tag> <xml>: the first value of <tag>, or nothing.
xml_value() { grep -o "<$1>[^<]*" <<<"$2" | head -n 1 | cut -d'>' -f2 || true; }
lock=$(s3 GET "?object-lock")
lmode=$(xml_value Mode "$lock")
ldays=$(xml_value Days "$lock")
lyears=$(xml_value Years "$lock")
# The bucket's answers are untrusted input to a root script, and bash arithmetic
# runs command substitutions in array subscripts: digits only, read as base 10.
[[ $ldays =~ ^[0-9]{1,6}$ ]] || ldays=''
[[ $lyears =~ ^[0-9]{1,6}$ ]] || lyears=''
held=$(s3 GET "/$okey?retention&versionId=$ovid")
hmode=$(xml_value Mode "$held")
huntil=$(date -u -d "$(xml_value RetainUntilDate "$held")" +%s 2>/dev/null || echo 0)
del=$(s3 DELETE "/$okey?versionId=$ovid" -o /dev/null -w '%{http_code}')
retention='<Retention><Mode>COMPLIANCE</Mode><RetainUntilDate>'$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)'</RetainUntilDate></Retention>'
md5=$(printf '%s' "$retention" | openssl dgst -md5 -binary | base64)
ret=$(s3 PUT "/$okey?retention&versionId=$ovid" -H "Content-MD5: $md5" -H 'Content-Type: application/xml' \
  --data-raw "$retention" -o /dev/null -w '%{http_code}')

fails=0
if [[ $lmode == COMPLIANCE ]] && ((10#${ldays:-0} >= 30 || 10#${lyears:-0} >= 1)); then
  echo "PASS the bucket's default retention is COMPLIANCE, ${ldays:+$ldays days}${lyears:+$lyears years}"
else
  echo "FAIL the bucket's default retention is ${lmode:-missing}, ${ldays:-0} days ${lyears:-0} years (needs COMPLIANCE, >= 30 days)"
  fails=1
fi
if [[ $hmode == COMPLIANCE ]] && ((huntil >= $(date -u +%s) + 29 * 86400)); then
  echo "PASS a new object version is retained in COMPLIANCE until $(date -u -d "@$huntil" +%Y-%m-%d)"
else
  echo "FAIL a new object version is retained ${hmode:-without a mode} until $(date -u -d "@$huntil" +%Y-%m-%d) (needs COMPLIANCE, >= 29 days)"
  fails=1
fi
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
