#!/usr/bin/env bash
# Offline tests of hardening.sh (P12a, issue #27 criterion 9): a fake `docker` on PATH answers
# `ps` and `inspect` with canned JSON, so every deviation can be planted and must be reported.
# Usage: deploy/tests/hardening.test.sh
set -euo pipefail
shopt -s lastpipe # expect runs in this shell, so its counters count

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script=$here/hardening.sh
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
mkdir -p "$T/bin"
cat >"$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
case $1 in
  ps) [[ -e $FIX/none ]] || echo id-one id-two ;;
  inspect) cat "$FIX/inspect.json" ;;
esac
STUB
chmod +x "$T/bin/docker"
export FIX=$T PATH=$T/bin:$PATH
failures=0 cases=0

# One hardened container of service $1.
base() {
  jq -n --arg s "$1" '{Id: ("id-" + $s), Name: ("/rws-" + $s + "-1"),
    Config: {User: "65532:65532", Env: [], Labels: {"com.docker.compose.service": $s, "com.docker.compose.project": "rws"}},
    HostConfig: {ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges:true"],
      Memory: 268435456, NanoCpus: 1000000000, PidsLimit: 64, Privileged: false, NetworkMode: "rws_db",
      PortBindings: {}, ExtraHosts: null, Sysctls: null, Binds: []},
    Mounts: [], NetworkSettings: {Ports: {}, Networks: {"rws_db": {}}}}'
}
pub='{"80/tcp":[{"HostIp":"192.0.2.1","HostPort":"80"}],"443/tcp":[{"HostIp":"192.0.2.1","HostPort":"443"}],"443/udp":[{"HostIp":"192.0.2.1","HostPort":"443"}]}'
owner='{"8443/tcp":[{"HostIp":"10.66.0.1","HostPort":"443"}]}'
fleet() { # the production stack, plus the jobs
  local s
  for s in caddy capture watchdog db load api publish publish-owner caddy-owner api-owner migrate backup basemap basemap-promote; do
    case $s in
      caddy) base "$s" | jq --argjson p "$pub" '.HostConfig.PortBindings = $p | .HostConfig.Sysctls = {"net.ipv4.ip_unprivileged_port_start": "80"}' ;;
      caddy-owner) base "$s" | jq --argjson p "$owner" '.HostConfig.PortBindings = $p' ;;
      *) base "$s" ;;
    esac
  done | jq -s .
}
# mutate <service> <jq update>: apply to that service's container(s).
mutate() { jq --arg s "$1" "map(if .Config.Labels[\"com.docker.compose.service\"] == \$s then ($2) else . end)"; }
add() { jq -s '.[0] + [.[1]]' - <(base "$1" | jq "${2:-.}"); }

# expect <name> <mode> <exit> <stderr-or-stdout regex> < fleet json
expect() {
  local name=$1 mode=$2 want=$3 pat=$4 out rc=0
  cases=$((cases + 1))
  cat >"$T/inspect.json"
  out=$("$script" "--$mode" 2>&1) || rc=$?
  if [[ $rc != "$want" ]] || ! grep -Eq -- "$pat" <<<"$out"; then
    failures=$((failures + 1))
    printf 'FAIL %s: exit %s (want %s), pattern %q\n%s\n' "$name" "$rc" "$want" "$pat" "$out" >&2
  else
    echo "ok   $name"
  fi
}

fleet | expect "prod: the hardened stack passes" prod 0 'OK, 14 container'
fleet | expect "prod: the table lists caddy-owner on 10.66.0.1" prod 0 'caddy-owner .*10\.66\.0\.1:8443/tcp'
fleet | jq 'map(select(.Config.Labels["com.docker.compose.service"] | IN("migrate","backup","basemap","basemap-promote") | not))' |
  expect "prod: jobs that do not exist are fine" prod 0 'OK, 10 container'
fleet | mutate api '.Config.User = "root"' | expect "root user" prod 1 'FAIL api .*runs as root'
fleet | mutate api '.Config.User = ""' | expect "no user" prod 1 'FAIL api .*runs as root'
fleet | mutate api '.Config.User = "0:0"' | expect "uid 0" prod 1 'FAIL api .*runs as root'
fleet | mutate load '.HostConfig.ReadonlyRootfs = false' | expect "writable rootfs" prod 1 'FAIL load .*writable'
fleet | mutate load '.HostConfig.CapDrop = null' | expect "no cap_drop" prod 1 'FAIL load .*CapDrop'
fleet | mutate load '.HostConfig.CapAdd = ["NET_BIND_SERVICE"]' | expect "cap_add on a non-caddy" prod 1 'FAIL load .*CapAdd is not empty'
fleet | mutate caddy '.HostConfig.CapAdd = ["NET_BIND_SERVICE"]' | expect "caddy may add NET_BIND_SERVICE" prod 0 'OK'
fleet | mutate caddy '.HostConfig.CapAdd = ["CAP_NET_BIND_SERVICE","SYS_ADMIN"]' | expect "caddy may not add SYS_ADMIN" prod 1 'FAIL caddy .*SYS_ADMIN'
fleet | mutate db '.HostConfig.SecurityOpt = []' | expect "no no-new-privileges" prod 1 'FAIL db .*no-new-privileges'
fleet | mutate db '.HostConfig.Memory = 0' | expect "no memory limit" prod 1 'FAIL db .*memory'
fleet | mutate db '.HostConfig.NanoCpus = 0' | expect "no cpu limit" prod 1 'FAIL db .*cpu'
fleet | mutate db '.HostConfig.PidsLimit = null' | expect "no pids limit" prod 1 'FAIL db .*pids'
fleet | mutate publish '.HostConfig.Privileged = true' | expect "privileged" prod 1 'FAIL publish .*privileged'
fleet | mutate publish '.HostConfig.NetworkMode = "host"' | expect "host network" prod 1 'FAIL publish .*host namespace'
fleet | mutate publish '.HostConfig.Binds = ["/var/run/docker.sock:/var/run/docker.sock"]' | expect "docker.sock" prod 1 'FAIL publish .*docker.sock'
fleet | mutate publish '.HostConfig.Sysctls = {"net.ipv4.ip_forward": "1"}' | expect "other sysctl" prod 1 'FAIL publish .*sysctl'
fleet | mutate api '.HostConfig.PortBindings = {"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8080"}]}' |
  expect "a port on a non-caddy service" prod 1 'FAIL api .*publishes ports'
fleet | mutate caddy '.HostConfig.PortBindings["443/tcp"] = [{"HostIp":"0.0.0.0","HostPort":"443"}]' |
  expect "caddy on 0.0.0.0" prod 1 'FAIL caddy .*wildcard bind'
fleet | mutate caddy '.HostConfig.PortBindings["443/tcp"] = [{"HostIp":"","HostPort":"443"}]' |
  expect "caddy with an empty HostIp" prod 1 'FAIL caddy .*wildcard bind'
fleet | mutate caddy '.NetworkSettings.Ports["443/tcp"] = [{"HostIp":"::","HostPort":"443"}]' |
  expect "caddy on :: (running state)" prod 1 'FAIL caddy .*wildcard bind'
fleet | mutate caddy '.HostConfig.PortBindings["8443/tcp"] = [{"HostIp":"192.0.2.1","HostPort":"8443"}]' |
  expect "caddy publishes 8443" prod 1 'FAIL caddy .*unexpected published port 8443/tcp'
fleet | mutate caddy '.HostConfig.PortBindings["80/tcp"] = [{"HostIp":"10.66.0.1","HostPort":"80"}]' |
  expect "public caddy on the WireGuard address" prod 1 'FAIL caddy .*WireGuard address'
fleet | mutate caddy '.HostConfig.PortBindings = {}' | expect "caddy publishes nothing" prod 1 'FAIL caddy .*publishes no port'
fleet | mutate caddy-owner '.HostConfig.PortBindings = {"8443/tcp":[{"HostIp":"0.0.0.0","HostPort":"443"}]}' |
  expect "owner port on 0.0.0.0" prod 1 'FAIL caddy-owner .*wildcard bind'
fleet | mutate caddy-owner '.HostConfig.PortBindings = {"8443/tcp":[{"HostIp":"192.0.2.1","HostPort":"443"}]}' |
  expect "owner port on a public address" prod 1 'FAIL caddy-owner .*not 10\.66\.0\.1'
fleet | mutate caddy-owner '.HostConfig.PortBindings = {}' | expect "owner port not published" prod 1 'FAIL caddy-owner .*publishes no port'
fleet | jq 'map(select(.Config.Labels["com.docker.compose.service"] != "watchdog"))' | expect "missing service" prod 1 'missing service: watchdog'
fleet | jq 'map(select(.Config.Labels["com.docker.compose.service"] != "caddy-owner"))' | expect "missing owner site" prod 1 'missing service: caddy-owner'
fleet | mutate backup '.Config.User = "root"' | expect "a job that runs as root" prod 1 'FAIL backup .*root'
fleet | mutate migrate '.HostConfig.ReadonlyRootfs = false' | expect "a job with a writable rootfs" prod 1 'FAIL migrate .*writable'
fleet | mutate capture '.HostConfig.ExtraHosts = ["rivierstanden.example:203.0.115.10"]' | expect "prod: ExtraHosts" prod 1 'FAIL capture .*ExtraHosts'
fleet | mutate capture '.Config.Env = ["NODE_EXTRA_CA_CERTS=/ci/fake/ca-bundle.pem"]' | expect "prod: NODE_EXTRA_CA_CERTS" prod 1 'FAIL capture .*NODE_EXTRA_CA_CERTS'
fleet | mutate capture '.NetworkSettings.Networks = {"rws_fake": {}}' | expect "prod: a network named *fake*" prod 1 'FAIL capture .*network rws_fake'
fleet | add probe '.HostConfig.PidsLimit = 0' | expect "prod: a CI stand-in is not known" prod 1 'FAIL probe .*not a container of this stack'
fleet | add fake-upstream | expect "prod: fake-upstream is not known" prod 1 'FAIL fake-upstream .*not a container of this stack'
echo '[]' | expect "no containers at all" prod 1 'missing service: caddy'
touch "$T/none"
echo '[]' | expect "no project containers" prod 1 'no container of the compose project'
rm "$T/none"

# --ci: the stand-ins and the overlay settings, nothing wider.
ci_fleet() {
  fleet |
    mutate capture '.HostConfig.ExtraHosts = ["rivierstanden.example:203.0.115.10"] | .Config.Env = ["NODE_EXTRA_CA_CERTS=/ci/fake/ca-bundle.pem"] | .NetworkSettings.Networks = {"rws_fake": {}}' |
    mutate watchdog '.HostConfig.ExtraHosts = ["hc-ping.com:203.0.115.10"] | .NetworkSettings.Networks = {"rws_fake": {}}' |
    add fake-upstream '.NetworkSettings.Networks = {"rws_fake": {}} | .HostConfig.Sysctls = {"net.ipv4.ip_unprivileged_port_start": "443"}' |
    add probe '.HostConfig.PidsLimit = 0 | .HostConfig.Memory = 0 | .HostConfig.NanoCpus = 0 | .HostConfig.PortBindings = {"8081/tcp":[{"HostIp":"203.0.114.10","HostPort":"8081"}]}' |
    add pebble '.Config.User = "" | .HostConfig.ReadonlyRootfs = false | .HostConfig.CapDrop = null | .HostConfig.SecurityOpt = [] | .HostConfig.Memory = 0 | .HostConfig.NanoCpus = 0 | .HostConfig.PidsLimit = 0' |
    add challtestsrv '.Config.User = "" | .HostConfig.ReadonlyRootfs = false | .HostConfig.CapDrop = null | .HostConfig.SecurityOpt = [] | .HostConfig.Memory = 0 | .HostConfig.NanoCpus = 0 | .HostConfig.PidsLimit = 0' |
    add minio '.Config.User = "" | .HostConfig.ReadonlyRootfs = false | .HostConfig.CapDrop = null | .HostConfig.SecurityOpt = [] | .HostConfig.Memory = 0 | .HostConfig.NanoCpus = 0 | .HostConfig.PidsLimit = 0 | .HostConfig.Sysctls = {"net.ipv4.ip_unprivileged_port_start": "443"}'
}
ci_fleet | expect "ci: the stack with every stand-in passes" ci 0 'OK, 19 container'
ci_fleet | mutate api '.Config.User = "root"' | expect "ci: a production service still must be hardened" ci 1 'FAIL api .*root'
ci_fleet | mutate api '.HostConfig.ExtraHosts = ["x:203.0.115.10"]' | expect "ci: ExtraHosts only on capture and watchdog" ci 1 'FAIL api .*ExtraHosts'
ci_fleet | mutate api '.Config.Env = ["NODE_EXTRA_CA_CERTS=/x"]' | expect "ci: NODE_EXTRA_CA_CERTS only on capture and watchdog" ci 1 'FAIL api .*NODE_EXTRA_CA_CERTS'
ci_fleet | mutate api '.NetworkSettings.Networks = {"rws_fake": {}}' | expect "ci: the fake network only for capture, watchdog, fake-upstream" ci 1 'FAIL api .*network rws_fake'
ci_fleet | mutate fake-upstream '.HostConfig.ReadonlyRootfs = false' | expect "ci: fake-upstream is fully hardened" ci 1 'FAIL fake-upstream .*writable'
ci_fleet | mutate fake-upstream '.HostConfig.Memory = 0' | expect "ci: fake-upstream has limits" ci 1 'FAIL fake-upstream .*memory'
ci_fleet | mutate probe '.HostConfig.PortBindings = {"8081/tcp":[{"HostIp":"0.0.0.0","HostPort":"8081"}]}' | expect "ci: probe on a wildcard" ci 1 'FAIL probe .*wildcard bind'
ci_fleet | mutate probe '.Config.User = "root"' | expect "ci: probe must be non-root" ci 1 'FAIL probe .*root'
ci_fleet | mutate minio '.HostConfig.PortBindings = {"443/tcp":[{"HostIp":"203.0.114.10","HostPort":"443"}]}' | expect "ci: minio publishes nothing" ci 1 'FAIL minio .*publishes ports'
ci_fleet | mutate minio '.HostConfig.Privileged = true' | expect "ci: minio not privileged" ci 1 'FAIL minio .*privileged'
ci_fleet | add mystery | expect "ci: an unknown container" ci 1 'FAIL mystery .*not a container of this stack'
ci_fleet | mutate caddy-owner '.HostConfig.PortBindings = {"8443/tcp":[{"HostIp":"0.0.0.0","HostPort":"443"}]}' | expect "ci: the owner port off 10.66.0.1" ci 1 'FAIL caddy-owner'

# #109: tunnel mode, cloudflared beside the stack: caddy publishes 127.0.0.1:80/tcp alone and joins rws_tunnel_edge,
# cloudflared is on rws_tunnel and rws_tunnel_edge only, no container has the token in its environment.
loop='{"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"80"}]}'
tunnel_fleet() {
  fleet |
    mutate caddy ".HostConfig.PortBindings = $loop | .NetworkSettings.Networks = {\"rws_public\": {}, \"rws_edge\": {}, \"rws_tunnel_edge\": {}}" |
    add cloudflared '.Config.User = "65532:65532" | .NetworkSettings.Networks = {"rws_tunnel": {}, "rws_tunnel_edge": {}}'
}
tunnel_fleet | expect "prod: a tunnel stack (caddy on 127.0.0.1:80 only, cloudflared on its two networks) passes" prod 0 'OK, 15 container'
tunnel_fleet | expect "prod: the table lists cloudflared and caddy on 127.0.0.1:80/tcp" prod 0 'caddy .*127\.0\.0\.1:80/tcp'
tunnel_fleet | expect "ci: a tunnel stack passes" ci 0 'OK, 15 container'
tunnel_fleet | mutate caddy '.HostConfig.PortBindings = {"80/tcp":[{"HostIp":"192.0.2.1","HostPort":"80"}]}' |
  expect "tunnel: caddy publishing 80 on a public address fails" prod 1 'FAIL caddy .*tunnel mode, but 80/tcp is published on 192\.0\.2\.1'
tunnel_fleet | mutate caddy ".HostConfig.PortBindings = $pub" |
  expect "tunnel: caddy publishing 443 while cloudflared runs fails" prod 1 'FAIL caddy .*tunnel mode, but 443/tcp is published on 192\.0\.2\.1'
tunnel_fleet | mutate caddy '.HostConfig.PortBindings = {"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"80"}],"443/tcp":[{"HostIp":"127.0.0.1","HostPort":"443"}]}' |
  expect "tunnel: caddy publishing 443 even on loopback fails" prod 1 'FAIL caddy .*tunnel mode, but 443/tcp'
tunnel_fleet | mutate caddy ".HostConfig.PortBindings = $pub" |
  expect "tunnel: the same fleet with the public ports and ci mode fails too" ci 1 'FAIL caddy .*tunnel mode'
fleet | expect "direct: with no cloudflared, caddy keeps 80, 443/tcp and 443/udp" prod 0 'OK, 14 container'
tunnel_fleet | mutate api '.NetworkSettings.Networks = {"rws_db": {}, "rws_tunnel_edge": {}}' |
  expect "tunnel: api on rws_tunnel_edge fails" prod 1 'FAIL api .*on the tunnel network rws_tunnel_edge'
tunnel_fleet | mutate db '.NetworkSettings.Networks = {"rws_db": {}, "rws_tunnel": {}}' |
  expect "tunnel: db on rws_tunnel fails" prod 1 'FAIL db .*on the tunnel network rws_tunnel'
tunnel_fleet | mutate caddy-owner '.NetworkSettings.Networks = {"rws_owner_edge": {}, "rws_tunnel_edge": {}}' |
  expect "tunnel: caddy-owner on rws_tunnel_edge fails" prod 1 'FAIL caddy-owner .*on the tunnel network rws_tunnel_edge'
tunnel_fleet | mutate cloudflared '.NetworkSettings.Networks = {"rws_tunnel": {}, "rws_tunnel_edge": {}, "rws_edge": {}}' |
  expect "tunnel: cloudflared also on rws_edge fails" prod 1 'FAIL cloudflared .*on the network rws_edge'
tunnel_fleet | mutate cloudflared '.NetworkSettings.Networks = {"rws_tunnel_edge": {}, "rws_db": {}}' |
  expect "tunnel: cloudflared also on rws_db fails" prod 1 'FAIL cloudflared .*on the network rws_db'
tunnel_fleet | mutate cloudflared '.Config.User = "root"' | expect "tunnel: cloudflared as root fails" prod 1 'FAIL cloudflared .*root'
tunnel_fleet | mutate cloudflared '.HostConfig.ReadonlyRootfs = false' | expect "tunnel: cloudflared with a writable rootfs fails" prod 1 'FAIL cloudflared .*writable'
tunnel_fleet | mutate cloudflared '.HostConfig.PortBindings = {"7844/tcp":[{"HostIp":"192.0.2.1","HostPort":"7844"}]}' |
  expect "tunnel: cloudflared publishing a port fails" prod 1 'FAIL cloudflared .*publishes ports'
# The token must not be in any environment, and the audit must not print it (a distinctive value, asserted absent).
secret=tok-9f3a7c1e-must-never-be-printed
for svc in cloudflared api caddy; do
  tunnel_fleet | mutate "$svc" ".Config.Env = [\"TUNNEL_TOKEN=$secret\"]" |
    expect "tunnel: TUNNEL_TOKEN in the environment of $svc fails" prod 1 "FAIL $svc .*TUNNEL_TOKEN is in the environment"
  cases=$((cases + 1))
  tunnel_fleet | mutate "$svc" ".Config.Env = [\"TUNNEL_TOKEN=$secret\"]" >"$T/inspect.json"
  printed=$("$script" --prod 2>&1 || true)
  if [[ -z $printed ]] || grep -qF -- "$secret" <<<"$printed"; then
    failures=$((failures + 1))
    echo "FAIL the token value is printed for $svc" >&2
  else
    echo "ok   the token value is never printed ($svc)"
  fi
done
# Even without cloudflared (a stray container), the variable is a deviation.
fleet | mutate api ".Config.Env = [\"TUNNEL_TOKEN=$secret\"]" | expect "direct: TUNNEL_TOKEN in any container fails" prod 1 'FAIL api .*TUNNEL_TOKEN is in the environment'
# cloudflared is optional: not running is fine, and a network named like a tunnel one is a deviation without it.
fleet | mutate api '.NetworkSettings.Networks = {"rws_db": {}, "rws_tunnel_edge": {}}' |
  expect "direct: a service on a tunnel network fails" prod 1 'FAIL api .*on the tunnel network rws_tunnel_edge'

# usage
cases=$((cases + 1))
if "$script" 2>/dev/null; then failures=$((failures + 1)); echo "FAIL usage: no argument must fail" >&2; else echo "ok   usage"; fi

echo "hardening.test.sh: $cases case(s), $failures failure(s)"
((failures == 0))
