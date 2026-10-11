#!/usr/bin/env bash
# CI only (loadtest.yml; as root): after a load or chaos phase, no container of the compose project `rws` was killed for
# memory (State.OOMKilled false) and none was restarted by the daemon (RestartCount 0), every expected service exists
# and is running (jobs excepted: they have exited). A missing service is a failure, not a skip.
#   oom-restart.sh [--allow-restart svc,svc,...]
# --allow-restart: services a chaos step stopped or crashed on purpose (the dependants of a stopped database): their
# RestartCount is printed but not judged. OOMKilled is never excused.
set -euo pipefail

allow=''
case ${1:-} in
  --allow-restart)
    allow=${2:?--allow-restart needs a service list}
    [[ $allow =~ ^[a-z0-9,-]+$ ]] || {
      echo "oom-restart: bad service list" >&2
      exit 64
    }
    ;;
  '') ;;
  *)
    echo "usage: oom-restart.sh [--allow-restart svc,svc,...]" >&2
    exit 64
    ;;
esac

# Long-running services of the stack (compose.yaml + overlays). Jobs (migrate, basemap, basemap-promote, backup) are
# profile/one-shot containers: only their OOMKilled is judged.
expected=(caddy capture watchdog db load api api-owner publish publish-owner caddy-owner fake-upstream)
fail=0
declare -A seen=()
printf '%-18s %-10s %-9s %-8s %s\n' service state oomkilled restarts note
while read -r id; do
  [[ -n $id ]] || continue
  read -r svc state oom restarts <<<"$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} {{.State.OOMKilled}} {{.RestartCount}}' "$id")"
  seen[$svc]=1
  note=''
  if [[ $oom != false ]]; then
    note+=' OOMKILLED'
    fail=1
  fi
  if [[ $restarts != 0 ]]; then
    if [[ ,$allow, == *",$svc,"* ]]; then note+=' restart allowed'; else
      note+=' RESTARTED'
      fail=1
    fi
  fi
  printf '%-18s %-10s %-9s %-8s %s\n' "$svc" "$state" "$oom" "$restarts" "$note"
done < <(docker ps -aq --filter label=com.docker.compose.project=rws)

for s in "${expected[@]}"; do
  if [[ -z ${seen[$s]:-} ]]; then
    echo "MISSING service $s"
    fail=1
  elif [[ $(docker inspect -f '{{.State.Status}}' "rws-$s-1") != running ]]; then
    echo "NOT RUNNING service $s ($(docker inspect -f '{{.State.Status}}' "rws-$s-1"))"
    fail=1
  fi
done
if ((fail != 0)); then
  echo "::error::oom-restart: a container was OOM-killed or restarted, or a service is missing or stopped (table above)"
  exit 1
fi
echo "oom-restart: ${#seen[@]} services, none OOM-killed, none restarted (allowed: ${allow:-none})"
