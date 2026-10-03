# PROJECT_NAME

A [Routecraft](https://routecraft.dev) project: one capability, `greet`, that an agent can
call as a tool and the project calls once at start to show it runs.

## Run it

```bash
PACKAGE_MANAGER_RUN start
```

That boots the project and runs `capabilities/hello-world`, which calls `greet` with a user
id. `greet` fetches the user over HTTP and logs a greeting. It needs a network on the first
run.

```bash
PACKAGE_MANAGER_RUN test        # the capability's own tests, which mock fetch
PACKAGE_MANAGER_RUN all         # format, typecheck, lint, test
```

## Give an agent the tool

`greet` is also an MCP tool: `craft.config.ts` serves every capability with an `mcp()`
source over stdio, so a client spawns this project and talks to it on the process's
standard streams. No port, no credential. Run the client from this folder, and send the log
to a file because standard output is the protocol.

Claude Code:

```bash
claude mcp add PROJECT_NAME -- bunx craft start --log-file craft.log
```

Then ask it: "greet user 1".

Clients configured in JSON (Cursor, Claude Desktop, VS Code and Copilot) do not start the
server from this folder, so give them absolute paths: the project's own `craft`, the project
folder, and the log file. Cursor (`.cursor/mcp.json`) and Claude Desktop
(`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "PROJECT_NAME": {
      "command": "/absolute/path/to/PROJECT_NAME/node_modules/.bin/craft",
      "args": [
        "start",
        "/absolute/path/to/PROJECT_NAME",
        "--log-file",
        "/absolute/path/to/PROJECT_NAME/craft.log"
      ]
    }
  }
}
```

VS Code and Copilot (`.vscode/mcp.json`) take the same command and arguments under
`"servers"`, with `"type": "stdio"`. `craft` runs on Bun, so a client that does not inherit
your shell's `PATH` needs Bun on its own.

A team shares the tool by running the project always on, serving MCP over HTTP behind
authentication, on service credentials no person holds. That is a config change, not a code
change: [Expose to an agent](https://routecraft.dev/docs/introduction/expose-to-an-agent) shows the
HTTP transport and [Local harness, team harness](https://routecraft.dev/docs/introduction/local-and-team-harness)
shows the step.

Every `craft start`, including the one a client spawns, runs the `hello-world` caller once,
so the greeting and its HTTP fetch happen on each connect until you delete that route. To stop
serving tools at all, remove `mcp()` from the capability's `.from()` and `mcp: {}` from
`craft.config.ts`; an `mcp()` source with no MCP server configured stops the start.

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
default-exports the routes and is the only file another capability may import. Give the
route an `mcp()` source and it is a tool, an `http()` source and it answers a request. A
source has to bring the body the capability's `.input()` expects: a `cron()` schedule brings
none, so a scheduled run is a small route of its own that builds the input and calls the
capability through `direct()`.

```ts
import { craft, direct, log } from "@routecraft/routecraft";
import { mcp } from "@routecraft/ai";

export default craft()
  .id("my-capability")
  .title("My capability")
  .description("What an agent reads before it decides to call this")
  .from(direct(), mcp())
  .transform((body) => body)
  .to(log());
```

Delete `capabilities/hello-world` once you no longer need it, and this file with it.

## Where to look next

- [What is Routecraft](https://routecraft.dev/docs/introduction) for the platform in one picture
- [Adapters](https://routecraft.dev/docs/reference/adapters) for what a route can talk to
- [Operations](https://routecraft.dev/docs/reference/operations) for what a route can do
- An agent harness you own, rather than a starter:
  `bunx create-routecraft my-agent --example https://github.com/routecraftjs/craft-harness`
