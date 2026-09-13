# PROJECT_NAME

A [Routecraft](https://routecraft.dev) project.

## Run it

```bash
PACKAGE_MANAGER_RUN start
```

That boots the project and runs `capabilities/hello-world`, which fetches a user over HTTP
and logs a greeting. It needs a network on the first run.

```bash
PACKAGE_MANAGER_RUN test        # the capability's own tests, which mock fetch
PACKAGE_MANAGER_RUN all         # format, typecheck, lint, test
```

## How it is laid out

`craft start` discovers the project from its folders, so nothing is registered by hand and
there is no entry file listing your routes.

```
capabilities/     one folder per capability, each with a route.ts
craft.config.ts   what discovery cannot work out on its own
```

Three more folders are discovered the same way when you add them: `plugins/`, `agents/` and
`skills/`. See [project structure](https://routecraft.dev/docs/introduction/project-structure).

## Add a capability

Copy `capabilities/hello-world` and rename it. `route.ts` is the public surface: it
default-exports the routes and is the only file another capability may import.

```ts
import { craft, direct, log } from "@routecraft/routecraft";

export default craft()
  .id("my-capability")
  .from(direct())
  .transform((body) => body)
  .to(log());
```

Delete `capabilities/hello-world` once you no longer need it, and this file with it.

## Where to look next

- [Documentation](https://routecraft.dev/docs)
- [Adapters](https://routecraft.dev/docs/reference/adapters) for what a route can talk to
- [Operations](https://routecraft.dev/docs/reference/operations) for what a route can do
- An agent harness you own, rather than a starter:
  `bunx create-routecraft my-agent --example https://github.com/routecraftjs/craft-harness`
