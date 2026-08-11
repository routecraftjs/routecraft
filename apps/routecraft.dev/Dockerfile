# Build context is the repository root, because the site is a workspace member
# and bun resolves the lockfile from there:
#   docker build -f apps/routecraft.dev/Dockerfile -t routecraft-dev .
FROM oven/bun:1 AS base
WORKDIR /repo

# --- Dependencies ---
# The manifests land in their own layer so a content-only change does not
# reinstall the toolchain.
FROM base AS deps
COPY package.json bun.lock bunfig.toml ./
COPY apps/routecraft.dev/package.json apps/routecraft.dev/
COPY packages packages
RUN bun install --frozen-lockfile

# --- Build ---
FROM deps AS build
COPY . .
RUN bun install --frozen-lockfile
WORKDIR /repo/apps/routecraft.dev
RUN bun run build

# --- Production ---
FROM base AS production
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup -s /bin/sh appuser

COPY --from=build /repo/apps/routecraft.dev/.output ./.output

RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD bun -e "fetch('http://localhost:3000/').then(r => {if(!r.ok) process.exit(1)}).catch(() => process.exit(1))"

CMD ["bun", "run", ".output/server/index.mjs"]
