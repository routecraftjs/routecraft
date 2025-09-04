---
title: DigitalOcean
---

Deploy RouteCraft to DigitalOcean App Platform. {% .lead %}

## App Platform

1) Repository
- Push your app to GitHub/GitLab, including `craft.config.ts` and a `Dockerfile` (or use the Node buildpack).

2) App creation
- Create App → connect repo → pick root directory.
- If using Dockerfile, App Platform will auto-detect. Otherwise set:
  - Runtime: Node 20
  - Build command: `pnpm install --frozen-lockfile && pnpm build`
  - Run command: `pnpm craft start ./craft.config.ts`

3) Environment
- Set `NODE_ENV=production` and any adapter secrets (e.g., API keys).

4) Scaling
- Choose a worker service for background processing. Use a web service only if you expose HTTP.

## Tips
- Prefer worker services for long‑running routes.

