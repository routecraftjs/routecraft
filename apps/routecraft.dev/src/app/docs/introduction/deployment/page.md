---
title: Deployment
---

Deploy RouteCraft as a Node.js process or a Docker container. {% .lead %}

## Node.js server

RouteCraft runs on any provider that supports Node.js. Add `build` and `start` scripts to your `package.json`:

```json
{
  "scripts": {
    "build": "tsc",
    "start": "craft run ./capabilities/index.js"
  }
}
```

Run `npm run build` to compile, then `npm run start` to launch.

## Docker

Use a multi-stage image to keep the runtime image small:

```dockerfile
# 1) Dependencies
FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 2) Build
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# 3) Production runtime
FROM node:20-alpine AS runner
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

CMD ["pnpm", "craft", "run", "./capabilities/index.js"]
```

---

## Related

{% quick-links %}

{% quick-link title="CLI reference" icon="installation" href="/docs/reference/cli" description="All craft CLI commands including run and build." /%}

{% /quick-links %}
