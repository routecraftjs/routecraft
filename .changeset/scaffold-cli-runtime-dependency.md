---
"create-routecraft": patch
---

A scaffolded project lists `@routecraft/cli` under `dependencies` rather than `devDependencies`. `craft start` is how the project runs in production, so `bun install --production` left an image without the `craft` binary it starts with. When an example repository lists the CLI as a dev dependency, the runtime entry wins and it is declared once. A project scaffolded earlier moves it itself: `bun add @routecraft/cli`, which also takes it out of `devDependencies`.
