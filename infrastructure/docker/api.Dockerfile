# Production image for apps/api — and, as a separate target, the one-off
# database migration job (docs/DEPLOYMENT.md).
#
#   docker build -f infrastructure/docker/api.Dockerfile -t undarga-api .
#   docker build -f infrastructure/docker/api.Dockerfile --target migrate -t undarga-api-migrate .
#
# NOT used by `docker compose up -d`, which runs infrastructure only.
#
# Multi-stage so the runtime image carries no compiler, no dev dependencies and
# no source. Prisma needs its query engine binaries at runtime, which is why
# node_modules is copied rather than rebuilt from a lockfile in the final stage.
# Reproducible: the lockfile is frozen and pnpm is pinned by `packageManager`
# (corepack). Pin the base image by digest in your registry for full
# reproducibility.

# --- deps ---------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable

# Every workspace manifest, so the frozen lockfile matches the workspace; the
# install itself is filtered to the API and what it depends on.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/eslint-config/package.json packages/eslint-config/

RUN pnpm install --frozen-lockfile --filter "@undarga/api..."

# --- build --------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /repo/packages ./packages
COPY . .

RUN pnpm --filter @undarga/shared build \
 && pnpm --filter @undarga/api exec prisma generate \
 && pnpm --filter @undarga/api build

# --- migrate (target) ---------------------------------------------------------
# Runs scripts/migrate-deploy.sh: prisma migrate deploy, hardening (roles,
# grants, RLS), reference data. Needs the dev dependencies (prisma CLI, pg,
# ts-node), so it is a separate image that runs once per release and exits.
# Never resets and never seeds demo data.
FROM build AS migrate
ENV NODE_ENV=production
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 -G nodejs migrate \
 && chown -R migrate:nodejs /repo/apps/api
USER migrate
WORKDIR /repo/apps/api
CMD ["sh", "scripts/migrate-deploy.sh"]

# --- prod-deps ----------------------------------------------------------------
FROM build AS prod-deps
RUN pnpm prune --prod

# --- runtime ------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Never run as root.
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 -G nodejs api

COPY --from=prod-deps --chown=api:nodejs /repo/node_modules ./node_modules
COPY --from=prod-deps --chown=api:nodejs /repo/packages/shared/dist ./packages/shared/dist
COPY --from=prod-deps --chown=api:nodejs /repo/packages/shared/package.json ./packages/shared/
COPY --from=prod-deps --chown=api:nodejs /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps --chown=api:nodejs /repo/apps/api/dist ./apps/api/dist
COPY --from=prod-deps --chown=api:nodejs /repo/apps/api/prisma ./apps/api/prisma
COPY --from=prod-deps --chown=api:nodejs /repo/apps/api/package.json ./apps/api/

# Local file storage (STORAGE_DRIVER=local) writes here; mount a volume on it.
# With S3 storage it stays empty.
RUN mkdir -p /app/storage && chown api:nodejs /app/storage
ENV STORAGE_LOCAL_ROOT=/app/storage
VOLUME ["/app/storage"]

USER api
EXPOSE 3000

# Readiness, not liveness: the orchestrator should not route traffic here until
# PostgreSQL (and Redis, when required) answers. Liveness is GET /api/v1/health.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SIGTERM reaches node directly (exec form): Nest's shutdown hooks drain the
# background workers and close database and Redis connections.
CMD ["node", "apps/api/dist/main.js"]
