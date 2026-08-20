# --- build ------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# Install against the manifests alone so a source-only change does not
# invalidate the dependency layer.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY . .

# The basemap style the built client points at. Baked in at build time because
# the client is a static bundle -- see .env.example.
ARG BASEMAP_STYLE_URL=""
ENV VITE_BASEMAP_STYLE_URL=$BASEMAP_STYLE_URL

# Compiles shared + server, and bundles the map client. The earlier image built
# only the TypeScript and shipped an API with no frontend.
#
# --force so the build never trusts incremental state it did not create. The
# .dockerignore above keeps *.tsbuildinfo out of the context, but that is one
# glob away from silently reverting to a no-op build and an image whose COPY
# of packages/*/dist fails; this does not depend on getting the glob right.
RUN npm run build -- --force && npm run build:web

# Drop dev dependencies from the tree we copy into the runtime image.
RUN npm prune --omit=dev

# --- runtime ----------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/migrations ./packages/server/migrations
COPY --from=build /app/packages/web/dist ./packages/web/dist

# Serve the bundled client from the API, so one container is the whole app.
ENV WEB_ROOT=/app/packages/web/dist

# The node image ships an unprivileged `node` user; nothing here needs root.
USER node

EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
