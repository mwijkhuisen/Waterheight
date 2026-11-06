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
FROM node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS go
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
# The upstream release flags (.goreleaser.yml: -trimpath, -s -w and the tags nobadger, nomysql and nopgx). Built inside
# its own module, Caddy would report its version as (devel): CustomVersion names the release instead.
ARG CADDY_VERSION=2.11.7
RUN m=github.com/caddyserver/caddy/v2@v${CADDY_VERSION} \
  && go mod download -json "$m" | grep -F '"Sum": "h1:yj0Y4fYZGPkSvibBJ1sTWE33xC0fxztVyXEW5iIdUT4="' \
  && cp -r "$(go env GOMODCACHE)/$m" /gosrc/caddy && chmod -R u+w /gosrc/caddy && cd /gosrc/caddy \
  && go get ${GO_FIXES} \
  && go build -trimpath -tags nobadger,nomysql,nopgx \
    -ldflags "-s -w -X github.com/caddyserver/caddy/v2.CustomVersion=v${CADDY_VERSION}" -o /gobin/caddy ./cmd/caddy

FROM node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN scripts/install-pnpm.sh /opt/pnpm
ENV PATH=/opt/pnpm/bin:$PATH
RUN pnpm install --frozen-lockfile && pnpm -F web build

FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
# The image's own binary carries a cap_net_bind_service file capability, and the kernel refuses to exec such a binary
# under cap_drop: ALL (caddy-docker#396). The build above replaces it (#252) and, freshly built, carries none. Caddy
# runs as uid 65533 with no capability and binds 80/443 through the container's net.ipv4.ip_unprivileged_port_start.
COPY --from=go /gobin/caddy /usr/bin/caddy
# #131 (R-095, owner 2026-10-16): the base still carries Alpine's zlib 1.3.2-r0 (CVE-2026-85091), so the fixed
# revision is pinned (BOM row). Alpine keeps only a branch's newest revision: once r1 is replaced the build fails, and
# the pin moves, or goes when the caddy image carries the fix. Caddy is a static Go binary and does not link zlib (apk
# and busybox do), so this clears the image's finding, not a path into Caddy.
# Owner 2026-10-26: the base's curl 8.22.0-r0 (CVE-2026-92392, High) goes, and with it libcurl and the libraries only
# it links (brotli-libs, c-ares, libidn2, libpsl, libunistring, nghttp2-libs, zstd-libs). Nothing here runs curl: the
# healthchecks and the e2e checks use busybox wget. This also retires #221's brotli-libs pin.
# #252: the base's musl and musl-utils 1.2.5-r23 (CVE-2026-107891, High) take r24 (built 2026-10-21), pinned like zlib.
ARG ZLIB_VERSION=1.3.2-r1
ARG MUSL_VERSION=1.2.5-r24
RUN apk add --no-cache "zlib=${ZLIB_VERSION}" "musl=${MUSL_VERSION}" "musl-utils=${MUSL_VERSION}" \
  && apk del curl \
  && mkdir -p /data/access /config \
  && chown -R 65533:65533 /data /config
# P12b: site.caddy imports phase-<RWS_SITE_PHASE>.caddy from its own directory: both phases ship, compose picks one.
COPY deploy/web/Caddyfile deploy/web/default-log.caddy deploy/web/site.caddy deploy/web/phase-prelaunch.caddy deploy/web/phase-launch.caddy deploy/web/edge-https.caddy deploy/web/edge-http.caddy deploy/web/Caddyfile.owner deploy/web/owner.caddy /etc/caddy/
COPY --from=build /src/apps/web/dist /srv/www
USER 65533:65533
