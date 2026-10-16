# Web image: stock Caddy with the Caddyfile and the static apps/web build baked
# in (A§3, A§11.1; issue #16 P1b). Bases pinned by digest. Build context: the
# repository root, through the allowlist in /.dockerignore.
FROM node:26.10.0-trixie-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33 AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN scripts/install-pnpm.sh /opt/pnpm
ENV PATH=/opt/pnpm/bin:$PATH
RUN pnpm install --frozen-lockfile && pnpm -F web build

FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
# The stock binary carries a cap_net_bind_service file capability, and the
# kernel refuses to exec such a binary under cap_drop: ALL (caddy-docker#396).
# A plain copy drops the xattr. Caddy runs as uid 65533 with no capability and
# binds 80/443 through the container's net.ipv4.ip_unprivileged_port_start.
# #131 (R-095, owner 2026-10-16): the base still carries Alpine's zlib 1.3.2-r0 (CVE-2026-85091), so the fixed
# revision is pinned (BOM row). Alpine keeps only a branch's newest revision: once r1 is replaced the build fails, and
# the pin moves, or goes when the caddy image carries the fix. Caddy itself does not link zlib.
ARG ZLIB_VERSION=1.3.2-r1
RUN apk add --no-cache "zlib=${ZLIB_VERSION}" \
  && cp /usr/bin/caddy /usr/bin/caddy.plain \
  && mv /usr/bin/caddy.plain /usr/bin/caddy \
  && mkdir -p /data/access /config \
  && chown -R 65533:65533 /data /config
# P12b: site.caddy imports phase-<RWS_SITE_PHASE>.caddy from its own directory: both phases ship, compose picks one.
COPY deploy/web/Caddyfile deploy/web/default-log.caddy deploy/web/site.caddy deploy/web/phase-prelaunch.caddy deploy/web/phase-launch.caddy deploy/web/edge-https.caddy deploy/web/edge-http.caddy deploy/web/Caddyfile.owner deploy/web/owner.caddy /etc/caddy/
COPY --from=build /src/apps/web/dist /srv/www
USER 65533:65533
