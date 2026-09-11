# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# OneBook ELD backend image — one image, two entrypoints (api / worker).
# Selected at runtime via CMD override in docker-compose.yml.
# ---------------------------------------------------------------------------

ARG NODE_VERSION=24-alpine

# ---- deps: install full dependency graph (incl. devDeps for build) --------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---- build: compile TS -> dist/, generate Prisma client --------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN if [ -f prisma/schema.prisma ]; then npx prisma generate; fi
RUN npm run build
# keep only production deps for the runtime stage
RUN npm prune --omit=dev

# ---- runtime: minimal image, non-root user ---------------------------------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S onebook && adduser -S onebook -G onebook

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma

USER onebook

EXPOSE 3000

# Default: API process. Overridden with `command: ["node", "dist/worker.js"]`
# for the worker service in docker-compose.yml.
CMD ["node", "dist/main.js"]
