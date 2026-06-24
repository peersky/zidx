# Multi-stage build for indexer worker + escalator + balance-refresh + API
# (Envio runs from its own container via the envio docker image referenced
# in docker-compose; this image bundles the Node services only.)

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.1 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN pnpm typecheck && pnpm exec tsc -p tsconfig.json

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.1 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY src/db/migrations ./dist/src/db/migrations
EXPOSE 3000
# Default to API; override via `command:` in compose for worker / escalator / etc.
CMD ["node", "dist/src/api/server.js"]
