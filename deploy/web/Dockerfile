# Web image: stock Caddy with the Caddyfile and the static apps/web build baked
# in (A§3, A§11.1; issue #16 P1b). Bases pinned by digest. Build context: the
# repository root, through the allowlist in /.dockerignore.
FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN scripts/install-pnpm.sh /opt/pnpm
ENV PATH=/opt/pnpm/bin:$PATH
RUN pnpm install --frozen-lockfile && pnpm -F web build

FROM caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b
# The stock binary carries a cap_net_bind_service file capability, and the
# kernel refuses to exec such a binary under cap_drop: ALL (caddy-docker#396).
# A plain copy drops the xattr. Caddy runs as uid 65533 with no capability and
# binds 80/443 through the container's net.ipv4.ip_unprivileged_port_start.
RUN cp /usr/bin/caddy /usr/bin/caddy.plain \
  && mv /usr/bin/caddy.plain /usr/bin/caddy \
  && mkdir -p /data/access /config \
  && chown -R 65533:65533 /data /config
COPY deploy/web/Caddyfile deploy/web/site.caddy deploy/web/Caddyfile.owner deploy/web/owner.caddy /etc/caddy/
COPY --from=build /src/apps/web/dist /srv/www
USER 65533:65533
