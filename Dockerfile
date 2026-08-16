FROM node:22-slim

WORKDIR /app

# Install dependencies against the manifests alone, so a source-only change
# does not invalidate the dependency layer.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
