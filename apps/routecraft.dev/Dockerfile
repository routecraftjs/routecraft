# The build context is the repository root, because the site is a bun workspace
# member and the lockfile lives there:
#   docker build -f apps/routecraft.dev/Dockerfile -t routecraft-dev .
FROM oven/bun:1 AS base
WORKDIR /repo

# --- Dependencies ---
# Manifests land in their own layer so a content-only change does not reinstall
# the toolchain. Every workspace member listed in the lockfile has to be present
# for a frozen install to resolve, which is why examples and packages come too.
FROM base AS deps
COPY package.json bun.lock bunfig.toml ./
COPY apps/routecraft.dev/package.json apps/routecraft.dev/
COPY examples/package.json examples/
COPY packages packages
RUN bun install --frozen-lockfile

# --- Build ---
FROM deps AS build

# Vite inlines VITE_* at build time, so these are build arguments rather than
# runtime environment. The docs version is what the channel switcher shows.
ARG VITE_DOC_VERSION
ARG VITE_BASE_URL=https://routecraft.dev
ARG VITE_POSTHOG_KEY
ARG VITE_POSTHOG_HOST
ENV VITE_DOC_VERSION=$VITE_DOC_VERSION \
    VITE_BASE_URL=$VITE_BASE_URL \
    VITE_POSTHOG_KEY=$VITE_POSTHOG_KEY \
    VITE_POSTHOG_HOST=$VITE_POSTHOG_HOST

# Set when the context carries a frozen docs tree plus a next-channel snapshot
# taken from main before the freeze: without it the prebuild would regenerate
# the next channel from the frozen content and ship the released docs twice.
ARG SKIP_DOCS_NEXT
ENV SKIP_DOCS_NEXT=$SKIP_DOCS_NEXT

COPY . .
RUN bun install --frozen-lockfile
WORKDIR /repo/apps/routecraft.dev
RUN bun run build

# --- Production ---
# The server bundle carries everything it needs, so the image ships .output and
# nothing else: no source, no node_modules, no build toolchain.
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
