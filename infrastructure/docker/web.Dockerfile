# Production image for apps/web (docs/DEPLOYMENT.md).
#
#   docker build -f infrastructure/docker/web.Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com/api/v1 -t undarga-web .
#
# Relies on Next's standalone output (`output: 'standalone'` in
# apps/web/next.config.ts), which traces the exact files the server needs.

# --- deps ---------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable

# Every workspace manifest, so the frozen lockfile matches the workspace; the
# install itself is filtered to the web app and what it depends on.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/eslint-config/package.json packages/eslint-config/

RUN pnpm install --frozen-lockfile --filter "@undarga/web..."

# --- build --------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
# The shared package's own node_modules (its compiler) — it is built below.
COPY --from=deps /repo/packages ./packages
COPY . .

# NEXT_PUBLIC_* is inlined at BUILD time, so the API URL must be supplied here
# and an image is therefore environment-specific. This is a property of Next,
# not a choice — a runtime-configurable URL needs a server-side config route.
# It also sets the API origin in the Content-Security-Policy.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1

RUN test -n "$NEXT_PUBLIC_API_URL" || (echo "NEXT_PUBLIC_API_URL build argument is required" && exit 1) \
 && pnpm --filter @undarga/shared build \
 && pnpm --filter @undarga/web build

# --- runtime ------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
# HOSTNAME: listen on every interface, not just the container's hostname.
ENV NODE_ENV=production PORT=3001 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1

RUN addgroup -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
