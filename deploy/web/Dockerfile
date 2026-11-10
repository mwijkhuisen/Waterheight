# Web image: Caddy with the Caddyfile and the static apps/web build baked in
# (A§3, A§11.1; issue #16 P1b). Bases pinned by digest. Build context: the
# repository root, through the allowlist in /.dockerignore.
# #252 (R-095, owner 2026-11-06): Caddy is built from its release module, the
# #131 fallback, not taken as the image's own binary, because every Caddy release
# up to 2.11.9 requires golang.org/x/net v0.60.0 and GO-2026-6860 is fixed only
# in v0.62.0. The Go tarball is sha256-pinned, the module is checked against its
# pinned go.sum hash, and every module download against the Go checksum database.
# GO_FIXES are the fixed versions (each at least 7 days old), none below the
# version Caddy 2.11.7 itself requires (otel/sdk v1.46.0 is Caddy's own), so the
# one list upgrades all four builds and never downgrades Caddy (a downgraded
# otel/sdk breaks its build). Back to the image's binary once a Caddy release
# clears Grype. The Go stage from ARG GO_VERSION to ARG GO_FIXES is the same text
# as in deploy/server/Dockerfile and deploy/backup/Dockerfile
# (test/check-bom.test.ts).
FROM node:26.12.1-trixie-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0 AS go
ARG GO_VERSION=1.27.2
ADD --checksum=sha256:ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5 \
  https://dl.google.com/go/go${GO_VERSION}.linux-amd64.tar.gz \
  /tmp/go.tar.gz
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && tar -C /usr/local -xzf /tmp/go.tar.gz \
  && mkdir -p /gosrc /gobin
# Only the Go module proxy, every download checked against the checksum database,
# whatever the base image or a later layer sets; no toolchain download, no cgo.
ENV PATH=/usr/local/go/bin:$PATH GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS= \
  GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOPRIVATE= GONOPROXY= GONOSUMDB= GOINSECURE=
ARG GO_FIXES="golang.org/x/net@v0.62.0 golang.org/x/crypto@v0.58.0 golang.org/x/text@v0.43.0 google.golang.org/grpc@v1.83.2 go.opentelemetry.io/otel/sdk@v1.46.0 github.com/klauspost/compress@v1.20.2 github.com/go-jose/go-jose/v4@v4.1.6 github.com/andybalholm/brotli@v1.2.7"
# Built as the upstream release is (.goreleaser.yml): cmd/caddy/main.go in a main module `caddy` that requires the
# release module, and the release flags (-trimpath, -s -w and the tags nobadger, nomysql and nopgx). So the build info
# names github.com/caddyserver/caddy/v2 v2.11.7 with its go.sum hash (the last line checks it): `caddy version` prints
# it, and Syft and Grype match Caddy's own advisories by it. Built inside its own module, Caddy is (devel) to both.
# The main module takes Caddy's own `go 1.26.0` line (go mod init would write the toolchain's 1.27.2), so the edge
# binary keeps the GODEBUG defaults of the release; neither go mod tidy nor GO_FIXES raises it (review SR-2).
ARG CADDY_VERSION=2.11.7
RUN m=github.com/caddyserver/caddy/v2@v${CADDY_VERSION} \
  && go mod download -json "$m" | grep -F '"Sum": "h1:yj0Y4fYZGPkSvibBJ1sTWE33xC0fxztVyXEW5iIdUT4="' \
  && mkdir /gosrc/caddy && cd /gosrc/caddy \
  && cp "$(go env GOMODCACHE)/$m/cmd/caddy/main.go" . \
  && go mod init caddy && go mod edit -go=1.26.0 -require="$m" && go mod tidy \
  && go get ${GO_FIXES} \
  && go build -trimpath -tags nobadger,nomysql,nopgx -ldflags '-s -w' -o /gobin/caddy . \
  && go version -m /gobin/caddy \
    | grep -E "^\s+dep\s+github.com/caddyserver/caddy/v2\s+v${CADDY_VERSION}\s+h1:yj0Y4fYZGPkSvibBJ1sTWE33xC0fxztVyXEW5iIdUT4=$"

FROM node:26.12.1-trixie-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0 AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN scripts/install-pnpm.sh /opt/pnpm
ENV PATH=/opt/pnpm/bin:$PATH
RUN pnpm install --frozen-lockfile && pnpm -F web build

FROM caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5
# The image's own binary carries a cap_net_bind_service file capability, and the kernel refuses to exec such a binary
# under cap_drop: ALL (caddy-docker#396). The build above replaces it (#252) and, freshly built, carries none. Caddy
# runs as uid 65533 with no capability and binds 80/443 through the container's net.ipv4.ip_unprivileged_port_start.
COPY --from=go /gobin/caddy /usr/bin/caddy
# #131 (R-095, owner 2026-10-16): the base still carries Alpine's zlib 1.3.2-r0 (CVE-2026-85091), so a fixed version
# is pinned (BOM row): 1.4-r0 (also fixes CVE-2026-4738) since 2026-11-06, the day Alpine replaced 1.3.2-r1, on the
# owner's release-age override. Alpine keeps only a branch's newest revision: once the pinned one is replaced the build
# fails, and the pin moves, or goes when the caddy image carries the fix. Caddy is a static Go binary and does not link
# zlib (apk and busybox do), so this clears the image's finding, not a path into Caddy.
# Owner 2026-10-26: the base's curl 8.22.0-r0 (CVE-2026-92392, High) goes, and with it libcurl and the libraries only
# it links (brotli-libs, c-ares, libidn2, libpsl, libunistring, nghttp2-libs, zstd-libs). Nothing here runs curl: the
# healthchecks and the e2e checks use busybox wget. This also retires #221's brotli-libs pin.
# #252: the base's musl and musl-utils 1.2.5-r23 (CVE-2026-107891, High) take r24 (built 2026-10-21), pinned like zlib.
ARG ZLIB_VERSION=1.4-r0
ARG MUSL_VERSION=1.2.5-r24
RUN apk add --no-cache "zlib=${ZLIB_VERSION}" "musl=${MUSL_VERSION}" "musl-utils=${MUSL_VERSION}" \
  && apk del curl \
  && mkdir -p /data/access /config \
  && chown -R 65533:65533 /data /config
# P12b: site.caddy imports phase-<RWS_SITE_PHASE>.caddy from its own directory: both phases ship, compose picks one.
COPY deploy/web/Caddyfile deploy/web/default-log.caddy deploy/web/site.caddy deploy/web/phase-prelaunch.caddy deploy/web/phase-launch.caddy deploy/web/edge-https.caddy deploy/web/edge-http.caddy deploy/web/Caddyfile.owner deploy/web/owner.caddy /etc/caddy/
COPY --from=build /src/apps/web/dist /srv/www
USER 65533:65533
