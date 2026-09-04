# Production image for apps/api.
#
# NOT used by `docker compose up -d`, which runs infrastructure only. This is
# for CI and deployment.
#
# Multi-stage so the runtime image carries no compiler, no dev dependencies and
# no source. Prisma needs its query engine binaries at runtime, which is why
# node_modules is copied rather than rebuilt from a lockfile in the final stage.

# --- deps ---------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/eslint-config/package.json packages/eslint-config/

RUN pnpm install --frozen-lockfile

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
 && pnpm --filter @undarga/api build \
 && pnpm prune --prod

# --- runtime ------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Never run as root.
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 -G nodejs api

COPY --from=build --chown=api:nodejs /repo/node_modules ./node_modules
COPY --from=build --chown=api:nodejs /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=api:nodejs /repo/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=api:nodejs /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=api:nodejs /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=api:nodejs /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build --chown=api:nodejs /repo/apps/api/package.json ./apps/api/

USER api
EXPOSE 3000

# Readiness, not liveness: the orchestrator should not route traffic here until
# PostgreSQL answers.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
