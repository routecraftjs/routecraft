---
title: Deployment
---

Run locally with the CLI; ship using Docker or your platform. {% .lead %}

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
CMD ["pnpm","craft","run","./examples"]
```
