---
title: DigitalOcean
---

Deploy Routecraft to DigitalOcean App Platform. {% .lead %}

## App Platform

DigitalOcean App Platform does not yet ship a first-class Bun runtime, so the `craft` CLI path deploys via a Dockerfile. Node embedding can use the platform's Node buildpack directly.

### Option A — Bun CLI via Dockerfile

1) Repository
- Push your app to GitHub/GitLab including `craft.config.ts` and the Bun Dockerfile from the [Deployment guide](/docs/introduction/deployment).

2) App creation
- Create App → connect repo → pick root directory.
- App Platform auto-detects the Dockerfile. No build/run command needed; the image's `CMD` runs `bun run start`.

3) Environment
- Set `NODE_ENV=production` and any adapter secrets (e.g., API keys).

4) Scaling
- Choose a worker service for long-running routes (cron, queues, IMAP). Use a web service only if you expose HTTP via an adapter.

### Option B — Node embedding via the Node buildpack

If your service embeds `@routecraft/routecraft` programmatically rather than using the CLI, the standard Node buildpack works:

- Runtime: Node 22 (or later)
- Build command: `npm ci --omit=dev` (or your build script)
- Run command: `node --experimental-strip-types src/server.ts` (drop the flag on Node 23.6+)

See [Programmatic Invocation](/docs/advanced/programmatic-invocation) for the embedding API.

## Tips
- Prefer worker services for long-running routes.
- If you mix paths in one repo, ship one Dockerfile per service rather than relying on buildpack auto-detection.
