---
title: Deployment
---

Deploy Routecraft on Bun for the CLI path, or embed it inside a Node application. {% .lead %}

## Choose a path

| Path | When | Runtime on host |
|------|------|------|
| **Bun CLI** | Capabilities are the whole app and `craft run` is the entry point. Default for projects scaffolded by `create-routecraft`. | Bun >= 1.1.0 |
| **Node embedding** | Routecraft runs inside an existing Node service (Express, Next.js, Fastify, a worker). The CLI is not used. | Node >= 22.6 |

The two paths can be mixed within the same project. See the [Runtime reference](/docs/reference/runtime) for the rationale.

## Bun CLI on a server

Routecraft's `craft` bin requires Bun on the host. Add a `start` script:

```json
{
  "scripts": {
    "start": "craft run ./capabilities/index.ts"
  }
}
```

Then run `bun run start`. Any provider that lets you install Bun (a long-running container, a VM, or a Bun-native runtime) will work.

### Docker (Bun base image)

Use a two-stage image with the official Bun base:

```dockerfile
# 1) Dependencies
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# 2) Production runtime
FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY capabilities ./capabilities

CMD ["bun", "run", "start"]
```

If your project uses `pnpm` or `npm` for dependency management, swap the install command in the `deps` stage (`pnpm install --frozen-lockfile --prod` or `npm ci --omit=dev`) but keep the `CMD ["bun", "run", "start"]` line — the runtime requirement is unchanged.

## Node embedding on a server

When you embed `@routecraft/routecraft` inside a Node service, deploy it the same way you would any Node application: build the service (or use Node's runtime type stripping on Node 22.6+), then run it with `node`. No Bun on the host.

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "--experimental-strip-types", "src/server.ts"]
```

The Node 23.6+ image enables type stripping by default; drop the flag in that case.

See the [Programmatic Invocation guide](/docs/advanced/programmatic-invocation) for the embedding API and runnable examples.

---

## Related

{% quick-links %}

{% quick-link title="Runtime reference" icon="installation" href="/docs/reference/runtime" description="Bun-only CLI, Node embedding, version floors." /%}
{% quick-link title="CLI reference" icon="installation" href="/docs/reference/cli" description="All craft CLI commands including run." /%}
{% quick-link title="Programmatic Invocation" icon="plugins" href="/docs/advanced/programmatic-invocation" description="Embed Routecraft inside Node, Express, or Next.js." /%}

{% /quick-links %}
