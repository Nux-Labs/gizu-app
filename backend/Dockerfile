# Keep build and runtime on the same reviewed Node patch and libc.
FROM node:24.15.0-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bash && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts/install-anvil.mjs scripts/anvil-fork.sh ./scripts/
RUN npm run build && npm run runtime:anvil && npm prune --omit=dev

FROM node:24.15.0-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bash && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/.runtime ./.runtime
USER node
ENV NODE_ENV=production PORT=3000 EARN_ANVIL_PATH=/app/.runtime/anvil-v1.8.3/anvil-fork
EXPOSE 3000
CMD ["node", "dist/server.js"]
