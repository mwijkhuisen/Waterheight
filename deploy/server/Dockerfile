# Server image: every role of apps/server (A§4, A§11.1; issue #16 P1b). Built on
# node:26 trixie-slim, run on distroless nodejs26 as uid 65532. Bases are pinned
# by digest (CLAUDE.md bill of materials). Build context: the repository root,
# through the allowlist in /.dockerignore.
FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# pnpm 12 is a native binary: the sha512-pinned script, never corepack.
RUN scripts/install-pnpm.sh /opt/pnpm
ENV PATH=/opt/pnpm/bin:$PATH
RUN pnpm install --frozen-lockfile \
  && node_modules/.bin/tsc -b apps/server \
  && pnpm --filter @rws/server deploy --prod /out/apps/server \
  && cp -r registry /out/registry

# The layout is part of the P1a ↔ P1b contract: capture reads <root>/registry
# next to <root>/apps/server/dist.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:afc6657a4b662f9cb69ca892b0596e55d6ef81a10e83ee8887b13f602877df89
WORKDIR /app
COPY --from=build /out /app
USER 65532:65532
ENTRYPOINT ["/nodejs/bin/node", "/app/apps/server/dist/main.js"]
