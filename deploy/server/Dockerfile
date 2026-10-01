# Server image: every role of apps/server (A§4, A§11.1; issue #16 P1b). Built on
# node:26 trixie-slim, run on distroless nodejs26 as uid 65532. Bases are pinned
# by digest (CLAUDE.md bill of materials). Build context: the repository root,
# through the allowlist in /.dockerignore.
FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS build
# The `migrate` role runs the dbmate release binary (P2a, plan D1), checked
# against its pinned sha256.
ARG DBMATE_VERSION=2.36.0
ADD --checksum=sha256:47e284b3d8cbad1ba5f090495aa05afd1bbd5f35e2ed5577aad06da74ce780ce \
  https://github.com/amacneil/dbmate/releases/download/v${DBMATE_VERSION}/dbmate-linux-amd64 \
  /tmp/dbmate
# The `basemap` role runs the go-pmtiles release binary (P3, ADR-0016) to extract
# the regional and planet tiles, checked against its pinned sha256 (a statically
# linked Go binary; the archive holds LICENSE, README.md and pmtiles).
ARG GO_PMTILES_VERSION=1.31.2
ADD --checksum=sha256:3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f \
  https://github.com/protomaps/go-pmtiles/releases/download/v${GO_PMTILES_VERSION}/go-pmtiles_${GO_PMTILES_VERSION}_Linux_x86_64.tar.gz \
  /tmp/go-pmtiles.tar.gz
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
  && mkdir -p /out/db /out/bin \
  && cp -r db/migrations /out/db/migrations \
  && install -m 0755 /tmp/dbmate /out/bin/dbmate \
  && tar -xzf /tmp/go-pmtiles.tar.gz -C /tmp pmtiles \
  && install -m 0755 /tmp/pmtiles /out/bin/pmtiles

# The layout is part of the P1a ↔ P1b contract: capture reads <root>/registry
# next to <root>/apps/server/dist; migrate runs <root>/bin/dbmate on
# <root>/db/migrations; basemap runs <root>/bin/pmtiles.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:afc6657a4b662f9cb69ca892b0596e55d6ef81a10e83ee8887b13f602877df89
WORKDIR /app
COPY --from=build /out /app
# The workspace packages resolve to their compiled dist/ (Node does not strip
# types inside node_modules); dev and tests keep running from src/.
ENV NODE_OPTIONS=--conditions=rws-dist
USER 65532:65532
ENTRYPOINT ["/nodejs/bin/node", "/app/apps/server/dist/main.js"]
