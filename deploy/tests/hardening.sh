#!/usr/bin/env bash
# Container hardening audit (P12a, issue #27 criterion 9; CLAUDE.md invariant 10).
# `docker inspect` of every container of the compose project "rws", services and
# jobs alike. Exits non-zero with one line per deviation, or prints a summary table.
#
#   deploy/tests/hardening.sh --prod   on the VPS (the owner runs it as root, or as a docker group member)
#   deploy/tests/hardening.sh --ci     in the compose end-to-end stack (deploy/tests/e2e/run.sh)
#
# Every container must: run as a non-root user, have a read-only root filesystem,
# drop ALL capabilities and add none (caddy and caddy-owner may add NET_BIND_SERVICE
# only), set no-new-privileges, have memory, cpu and pids limits, be neither
# privileged nor on the host network or pid namespace, mount no docker.sock and set
# no sysctl but net.ipv4.ip_unprivileged_port_start.
# Published ports: only caddy and caddy-owner, only on an explicit address (never
# empty, 0.0.0.0 or ::), caddy on 80/tcp, 443/tcp and 443/udp and never on the
# WireGuard address, caddy-owner only on 10.66.0.1.
# A service of the production stack that is not running fails the audit, so does
# any container the stack does not know. Jobs (migrate, backup, basemap,
# basemap-promote) are audited when a container of them exists.
# --prod also fails on extra_hosts, NODE_EXTRA_CA_CERTS and a network named *fake*.
# --ci allows exactly the CI stand-ins and overlay settings, no others:
#   capture and watchdog: extra_hosts, NODE_EXTRA_CA_CERTS, the network `fake`;
#   fake-upstream (compose.fake.yaml): fully hardened; it may sit on `fake`;
#   probe (compose.ci.yaml): the web image on one explicit address (203.0.114.10:8081); no limits;
#   pebble, challtestsrv, minio (compose.ci.yaml): third-party CI images, exempt from
#     user, read-only, capabilities, no-new-privileges and limits; they publish nothing;
#     minio's sysctl net.ipv4.ip_unprivileged_port_start is the only one allowed.
set -euo pipefail

mode=
case ${1:-} in
  --prod) mode=prod ;;
  --ci) mode=ci ;;
  *) echo "usage: ${0##*/} --prod|--ci" >&2; exit 2 ;;
esac
(($# == 1)) || { echo "usage: ${0##*/} --prod|--ci" >&2; exit 2; }
command -v docker >/dev/null || { echo "hardening: docker not found" >&2; exit 2; }
command -v jq >/dev/null || { echo "hardening: jq not found" >&2; exit 2; }

ids=$(docker ps -aq --filter label=com.docker.compose.project=rws)
if [[ -z $ids ]]; then
  echo "FAIL: no container of the compose project rws" >&2
  exit 1
fi
# shellcheck disable=SC2086 # ids are hex words
inspected=$(docker inspect $ids)

# One TSV line per fact: "row<TAB>cells..." for the table, "fail<TAB>text" per deviation.
# shellcheck disable=SC2016 # the jq program is single-quoted on purpose
program='
def required: ["caddy","capture","watchdog","db","load","api","publish","publish-owner","caddy-owner","api-owner"];
def jobs: ["migrate","backup","basemap","basemap-promote"];
def standins: ["probe","pebble","challtestsrv","minio","fake-upstream"];
def third: ["user","ro","caps","nnp","limits"];
def exempt($s): if $mode != "ci" then [] else
  ({"probe": ["limits"], "pebble": third, "challtestsrv": third, "minio": third}[$s] // []) end;
def wild: (.HostIp // "") as $h | ($h == "" or $h == "0.0.0.0" or $h == "::" or $h == "[::]");
def binds: [ ((.HostConfig.PortBindings // {}), (.NetworkSettings.Ports // {}))
             | to_entries[] | .key as $k | (.value // [])[] | {port: $k, HostIp: (.HostIp // "")} ] | unique;
def strip: sub("^CAP_"; "");

([.[] | .Config.Labels["com.docker.compose.service"] // ""] | unique) as $present
| ((required[] | select(. as $r | $present | index($r) | not)
    | "fail\tmissing service: \(.) is not running")),
  (.[] | . as $c
    | ($c.Config.Labels["com.docker.compose.service"] // "") as $svc
    | ($c.Name | ltrimstr("/")) as $name
    | ("\($svc) (\($name))") as $id
    | exempt($svc) as $ex
    | ($c.HostConfig) as $h
    | ($c.Config.User // "") as $user
    | ($h.CapAdd // [] | map(strip)) as $add
    | ($h.CapDrop // [] | map(strip)) as $drop
    | ($h.SecurityOpt // []) as $sec
    | ($c | binds) as $b
    | ($c.NetworkSettings.Networks // {} | keys) as $nets
    | (($c.Config.Env // []) | map(select(startswith("NODE_EXTRA_CA_CERTS=")))) as $ca
    | ($h.ExtraHosts // []) as $eh
    | ($mode == "ci" and ($svc == "capture" or $svc == "watchdog")) as $ciwatch
    | def bad($check; $msg): if ($ex | index($check)) then empty else "fail\t\($id): \($msg)" end;
      if $svc == "" then "fail\t\($name): not labelled with a compose service"
      elif ((required + jobs + (if $mode == "ci" then standins else [] end)) | index($svc) | not)
        then "fail\t\($id): not a container of this stack"
      else (
         (if (($user | split(":")[0]) // "") as $u | ($u == "" or $u == "root" or $u == "0")
            then bad("user"; "runs as root or as no explicit user (User=\"\($user)\")") else empty end),
         (if $h.ReadonlyRootfs != true then bad("ro"; "root filesystem is writable") else empty end),
         (if ($drop | index("ALL")) == null then bad("caps"; "CapDrop does not contain ALL") else empty end),
         (if ($svc == "caddy" or $svc == "caddy-owner")
            then ($add | map(select(. != "NET_BIND_SERVICE")) | if length > 0 then bad("caps"; "CapAdd beyond NET_BIND_SERVICE: \(join(","))") else empty end)
            else (if ($add | length) > 0 then bad("caps"; "CapAdd is not empty: \($add | join(","))") else empty end) end),
         (if ($sec | map(select(. == "no-new-privileges" or . == "no-new-privileges:true" or . == "no-new-privileges=true")) | length) == 0
            then bad("nnp"; "no-new-privileges is not set") else empty end),
         (if (($h.Memory // 0) <= 0) then bad("limits"; "no memory limit") else empty end),
         (if (($h.NanoCpus // 0) <= 0) then bad("limits"; "no cpu limit") else empty end),
         (if (($h.PidsLimit // 0) <= 0) then bad("limits"; "no pids limit") else empty end),
         (if $h.Privileged == true then "fail\t\($id): privileged" else empty end),
         (if ($h.NetworkMode == "host" or $h.PidMode == "host" or $h.IpcMode == "host" or $h.UsernsMode == "host")
            then "fail\t\($id): shares a host namespace" else empty end),
         (if (([($c.Mounts // [])[] | .Source // ""] + ($h.Binds // [])) | map(select(test("docker\\.sock"))) | length) > 0
            then "fail\t\($id): mounts docker.sock" else empty end),
         (($h.Sysctls // {}) | keys[] | select(. != "net.ipv4.ip_unprivileged_port_start")
            | "fail\t\($id): sysctl \(.) is set"),
         (if ($svc == "caddy" or $svc == "caddy-owner" or ($mode == "ci" and $svc == "probe")) then empty
          elif ($b | length) > 0 then "fail\t\($id): publishes ports (\($b | map(.port) | join(",")))" else empty end),
         ($b[] | select(wild) | "fail\t\($id): wildcard bind for \(.port) (HostIp=\"\(.HostIp)\")"),
         (if $svc == "caddy" then
            (if ($b | length) == 0 then "fail\t\($id): publishes no port" else empty end),
            ($b[] | select(.HostIp == "10.66.0.1") | "fail\t\($id): public port \(.port) on the WireGuard address"),
            ($b[] | select([.port] | inside(["80/tcp","443/tcp","443/udp"]) | not) | "fail\t\($id): unexpected published port \(.port)")
          elif $svc == "caddy-owner" then
            (if ($b | length) == 0 then "fail\t\($id): the owner site publishes no port (expected 10.66.0.1)" else empty end),
            ($b[] | select(.HostIp != "10.66.0.1" and (wild | not)) | "fail\t\($id): owner port \(.port) on \(.HostIp), not 10.66.0.1")
          elif $mode == "ci" and $svc == "probe" then
            ($b[] | select(.HostIp != "203.0.114.10") | "fail\t\($id): probe port \(.port) on \(.HostIp)")
          else empty end),
         (if ($eh | length) > 0 and ($ciwatch | not) then "fail\t\($id): ExtraHosts set (\($eh | join(",")))" else empty end),
         (if ($ca | length) > 0 and ($ciwatch | not) then "fail\t\($id): NODE_EXTRA_CA_CERTS set" else empty end),
         ($nets[] | select(test("fake")) | select(($ciwatch or ($mode == "ci" and $svc == "fake-upstream")) | not)
            | "fail\t\($id): on the network \(.)"),
         ("row\t\($svc)\t\($user)\t\($h.ReadonlyRootfs)\t\($drop | join(","))\t\($add | join(",") | if . == "" then "-" else . end)\t\(if ($sec | map(select(startswith("no-new-privileges"))) | length) > 0 then "yes" else "NO" end)\t\(($h.Memory // 0) / 1048576 | floor)M\t\(($h.NanoCpus // 0) / 1e9)\t\($h.PidsLimit // 0)\t\($b | map("\(.HostIp):\(.port)") | join(",") | if . == "" then "-" else . end)")
       ) end)'

out=$(jq -r --arg mode "$mode" "$program" <<<"$inspected")
fails=$(grep -c '^fail' <<<"$out" || true)
if ((fails > 0)); then
  grep '^fail' <<<"$out" | sed -e 's/^fail\t/FAIL /' | sort -u >&2
  echo "hardening ($mode): $(sort -u <<<"$(grep '^fail' <<<"$out")" | wc -l) deviation(s)" >&2
  exit 1
fi
{
  printf 'service\tuser\tro\tcapdrop\tcapadd\tnnp\tmem\tcpus\tpids\tports\n'
  grep '^row' <<<"$out" | cut -f2- | sort -u
} | awk -F'\t' '{ for (i = 1; i <= NF; i++) { c[NR, i] = $i; if (length($i) > w[i]) w[i] = length($i) } n = NF }
  END { for (r = 1; r <= NR; r++) { line = ""; for (i = 1; i <= n; i++) line = line sprintf("%-" w[i] "s  ", c[r, i]); print line } }'
echo "hardening ($mode): OK, $(grep -c '^row' <<<"$out") container(s)"
