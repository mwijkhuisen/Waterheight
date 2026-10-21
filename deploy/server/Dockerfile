# Server image: every role of apps/server (A§4, A§11.1; issue #16 P1b). Built on
# node:26 trixie-slim, run on distroless nodejs26 as uid 65532. Bases are pinned
# by digest (CLAUDE.md bill of materials). Build context: the repository root,
# through the allowlist in /.dockerignore.
# The `migrate` role runs dbmate (P2a, plan D1) and the `basemap` role go-pmtiles
# (P3, ADR-0016), both statically linked Go binaries.
# #131 (R-095): both are built from their release modules, not taken as the
# release binaries, because those carry High Grype findings (Go stdlib, x/net,
# x/crypto, x/text, gRPC, otel/sdk) that no upstream release fixes yet. The Go
# tarball is sha256-pinned, each module is checked against its pinned go.sum hash,
# and every module download against the Go checksum database. GO_FIXES are the
# fixed versions (each at least 7 days old). Back to the release binaries once
# they clear Grype. The Go stage from ARG GO_VERSION to ARG GO_FIXES is the same
# text as in deploy/backup/Dockerfile (test/check-bom.test.ts).
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
ARG GO_FIXES="golang.org/x/net@v0.60.0 golang.org/x/crypto@v0.57.0 golang.org/x/text@v0.42.0 google.golang.org/grpc@v1.83.2 go.opentelemetry.io/otel/sdk@v1.44.0"
# Upstream builds dbmate with cgo for its SQLite driver only; we use PostgreSQL alone.
ARG DBMATE_VERSION=2.36.0
RUN m=github.com/amacneil/dbmate/v2@v${DBMATE_VERSION} \
  && go mod download -json "$m" | grep -F '"Sum": "h1:oWxpNxkPSJ57UNaP9x/Icj/Kw12QNiWVzNnBLWkHcLE="' \
  && cp -r "$(go env GOMODCACHE)/$m" /gosrc/dbmate && chmod -R u+w /gosrc/dbmate && cd /gosrc/dbmate \
  && go get ${GO_FIXES} \
  && go build -trimpath -ldflags '-s' -o /gobin/dbmate .
# goreleaser's default flags of the upstream release (.goreleaser.yml), with
# main.version only (commit and date stay "none" and "unknown"; nothing reads them).
ARG GO_PMTILES_VERSION=1.31.2
RUN m=github.com/protomaps/go-pmtiles@v${GO_PMTILES_VERSION} \
  && go mod download -json "$m" | grep -F '"Sum": "h1:xYXagv2oKJarheCdOIGg8MvYRp8Y03MBs9jegxf4NDQ="' \
  && cp -r "$(go env GOMODCACHE)/$m" /gosrc/pmtiles && chmod -R u+w /gosrc/pmtiles && cd /gosrc/pmtiles \
  && go get ${GO_FIXES} \
  && go build -trimpath -ldflags "-s -w -X main.version=${GO_PMTILES_VERSION}" -o /gobin/pmtiles .

FROM node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# pnpm 12 is a native binary: the sha512-pinned script, never corepack.
RUN scripts/install-pnpm.sh /opt/pnpm
ENV PATH=/opt/pnpm/bin:$PATH
# `tsc -b apps/server` also builds packages/core and packages/contracts to their
# dist/; `pnpm deploy` copies their "files" (dist) into the output's node_modules.
RUN pnpm install --frozen-lockfile \
  && node_modules/.bin/tsc -b apps/server \
  && pnpm --filter @rws/server deploy --prod /out/apps/server \
  && cp -r registry /out/registry \
  && mkdir -p /out/db \
  && cp -r db/migrations /out/db/migrations

# The layout is part of the P1a ↔ P1b contract: capture reads <root>/registry
# next to <root>/apps/server/dist; migrate runs <root>/bin/dbmate on
# <root>/db/migrations; basemap runs <root>/bin/pmtiles.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:a3bb283a564754266646d6029c5b6aa4f760b9415dae1398db8d7f8142ee1375
WORKDIR /app
COPY --from=build /out /app
COPY --from=go /gobin /app/bin
# The workspace packages resolve to their compiled dist/ (Node does not strip
# types inside node_modules); dev and tests keep running from src/.
ENV NODE_OPTIONS=--conditions=rws-dist
# The git commit of the release (release.yml passes it); `dev` for any other
# build. The api reports it in /api/v1/meta and accepts nothing but 40 hex
# characters or `dev`.
ARG RWS_BUILD=dev
ENV RWS_BUILD=${RWS_BUILD}
USER 65532:65532
ENTRYPOINT ["/nodejs/bin/node", "/app/apps/server/dist/main.js"]
