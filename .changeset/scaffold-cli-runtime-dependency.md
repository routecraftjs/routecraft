---
"create-routecraft": patch
---

A scaffolded project lists `@routecraft/cli` under `dependencies` rather than `devDependencies`. `craft start` is how the project runs in production, so `bun install --production` left an image without the `craft` binary it starts with. When an example repository lists the CLI as a dev dependency, the runtime entry wins and it is declared once. A project scaffolded earlier moves the entry itself: `bun remove @routecraft/cli && bun add @routecraft/cli`, or move the line from `devDependencies` to `dependencies` in `package.json` and run `bun install`. A bare `bun add` keeps an entry in the group it is already in.
