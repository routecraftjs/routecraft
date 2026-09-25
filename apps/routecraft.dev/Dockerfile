# The build context is the repository root, because the site is a bun workspace
# member and the lockfile lives there:
#   docker build -f apps/routecraft.dev/Dockerfile -t routecraft-dev .
# Pinned, not floating. The repo runs bun 1.3.11 everywhere else (root
# package.json `packageManager`, which setup-bun reads in CI), and `oven/bun:1`
# drifted to 1.3.14, whose `bun install` hangs in "Resolving dependencies"
# here: the same install, same lockfile and same .npmrc completes on the CI
# runner in under two minutes. Keep this, and the production stage's
# `-distroless` tag, in step with `packageManager`.
FROM oven/bun:1.3.11 AS base
WORKDIR /repo

# --- Dependencies ---
# Manifests land in their own layer so a content-only change does not reinstall
# the toolchain. Every workspace member listed in the lockfile has to be present
# for a frozen install to resolve, which is why examples and packages come too.
#
# Lifecycle scripts are skipped: the core package pulls in better-sqlite3, whose
# install script compiles native bindings through node-gyp, and this image has
# no toolchain for that. The docs site never loads it.
FROM base AS deps
COPY package.json bun.lock bunfig.toml ./
COPY apps/routecraft.dev/package.json apps/routecraft.dev/
COPY examples/package.json examples/
COPY packages packages
RUN bun install --frozen-lockfile --ignore-scripts

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

# No second install: the deps stage above already copied every workspace
# manifest and the lockfile, so the dependency graph is fully resolved by
# then, and .dockerignore keeps this COPY from touching node_modules. A
# manifest arriving only here would fail the deps install outright, since a
# frozen install needs every member the lockfile names.
COPY . .
WORKDIR /repo/apps/routecraft.dev
RUN bun run build

# --- Production ---
# The server bundle carries everything it needs, so the image ships .output and
# nothing else: no source, no node_modules, no build toolchain. Distroless adds
# no shell and no package manager, and runs as the unprivileged `nonroot` user.
FROM oven/bun:1.3.11-distroless AS production
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /repo/apps/routecraft.dev/.output ./.output

USER nonroot

EXPOSE 3000

# Exec form: the shell form needs a /bin/sh this image does not have.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["/usr/local/bin/bun", "-e", "fetch('http://localhost:3000/').then(r => {if(!r.ok) process.exit(1)}).catch(() => process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["run", ".output/server/index.mjs"]
