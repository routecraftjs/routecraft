---
"create-routecraft": patch
---

A Bun project now scaffolds with a production `Dockerfile` and `.dockerignore`. The image runs on the distroless Bun image as the unprivileged `nonroot` user, pins the Bun version the project pins, and keeps `.env` files out of the build context. It is the image Routecraft's own CI scans on every change, and it passes the container scans enterprise registries run where the `oven/bun:1-slim` image the deployment guide used to suggest carried critical OS vulnerabilities.
