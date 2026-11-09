# Build from the repository root: docker build --platform linux/amd64 -f backend/Dockerfile .
FROM node:24.19.0-bookworm AS build
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --include=dev

COPY backend/tsconfig.json backend/tsconfig.test.json ./
COPY backend/src ./src
COPY backend/scripts ./scripts
COPY backend/test ./test
COPY shared/gas-policy-v1.json /app/shared/gas-policy-v1.json
RUN npm run typecheck && npm test
RUN npm run build:render && npm prune --omit=dev

# Trust the RDS certificate chain while retaining hostname verification in pg.
RUN mkdir -p /app/certs && curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 --max-time 120 \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    --output /app/certs/rds-global-bundle.pem

FROM node:24.19.0-bookworm-slim AS runtime
WORKDIR /app/backend
ENV NODE_ENV=production \
    PORT=3000 \
    EARN_ANVIL_PATH=/app/backend/.runtime/anvil-v1.8.3/anvil-fork \
    NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem

COPY --from=build /app/backend/package.json ./package.json
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/.runtime ./.runtime
COPY --from=build /app/certs /app/certs

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
