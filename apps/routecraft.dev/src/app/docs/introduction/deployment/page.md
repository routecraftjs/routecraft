---
title: Deployment
---

Deploy RouteCraft as a Node.js process or a Docker container. {% .lead %}

## Node.js server

RouteCraft runs on any provider that supports Node.js. Add a `start` script to your `package.json`:

```json
{
  "scripts": {
    "start": "craft run ./capabilities/index.ts"
  }
}
```

Run `npm run start` to launch.

## Docker

Use a two-stage image to keep the runtime image small:

```dockerfile
# 1) Dependencies
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# 2) Production runtime
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY capabilities ./capabilities

CMD ["pnpm", "craft", "run", "./capabilities/index.ts"]
```

---

## Related

{% quick-links %}

{% quick-link title="CLI reference" icon="installation" href="/docs/reference/cli" description="All craft CLI commands including run and build." /%}

{% /quick-links %}
