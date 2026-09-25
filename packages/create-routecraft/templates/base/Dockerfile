# syntax=docker/dockerfile:1

# The production image for this project: docker build -t PROJECT_NAME .
#
# Dependencies install on the full Bun image, which has the shell that
# packages' install scripts need. Only node_modules leaves that stage.
FROM oven/bun:BUN_VERSION AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
# The one directory the running process writes to (telemetry and other local
# state). Created here because the runtime image has no shell to run mkdir.
RUN mkdir -p /app/.routecraft

# Distroless: no shell and no package manager, so the image carries almost
# nothing a vulnerability scanner can flag, and it runs as the unprivileged
# `nonroot` user rather than root.
FROM oven/bun:BUN_VERSION-distroless
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps --chown=nonroot:nonroot /app/.routecraft ./.routecraft
COPY . .
USER nonroot
# `bun run start` needs a shell this image does not have, so the command the
# start script runs is called directly.
ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["node_modules/.bin/craft", "start", "--log-level", "info"]
