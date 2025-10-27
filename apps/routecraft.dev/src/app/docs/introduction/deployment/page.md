---
title: Deployment
---

Deploy RouteCraft via a Node.js server, Docker image, or DigitalOcean App Platform. {% .lead %}

| Deployment option | Feature support |
| --- | --- |
| [Node.js server](#nodejs-server) | All |
| [Docker container](#docker) | All |
| [DigitalOcean App Platform](/docs/introduction/deployment/digitalocean) | All |

## Node.js server

Routecraft can be deployed to any provider that supports Node.js. Ensure your `package.json` has the `build` and `start` scripts:

```json
{
  "scripts": {
    "build": "tsc",
    "start": "craft run ./routes/index.mjs"
  }
}
```

Then, run `npm run build` to build your application and `npm run start` to start the Node.js server. This server supports all Routecraft features.

## Docker

Routecraft can be deployed to any provider that supports Docker containers. This includes container orchestrators like Kubernetes or a cloud provider that runs Docker.

Docker deployments support all Routecraft features. Use a multi-stage image to keep the runtime small:

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

CMD ["pnpm", "craft", "run", "./routes/index.mjs"]
```

## Providers

- [DigitalOcean (App Platform)](/docs/introduction/deployment/digitalocean)