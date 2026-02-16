# @routecraft/ai

AI and MCP integrations for RouteCraft.

## Installation

```bash
npm install @routecraft/ai
```

or

```bash
pnpm add @routecraft/ai
```

## Quick Start

```typescript
import { tool } from '@routecraft/ai';
import { craft, simple } from '@routecraft/routecraft';

craft()
  .from(simple({ query: 'hello' }))
  .to(tool('my-tool'));

craft()
  .from(tool('my-tool'))
  .process((body) => body);
```

## Features

- **tool()**: Alias for `direct()` with semantics for AI/MCP—discoverable routes with optional schema and description
- **Discovery**: Tools register in the context store for querying endpoints, descriptions, and schemas
- **Schema validation**: Use Zod (or other Standard Schema libs) for body and header validation on tools
- **Coming soon**: LLM adapters (OpenAI, Gemini), MCP source/destination, agent routing

## Connecting from Cursor / Claude Desktop (MCP)

To connect an MCP client (Cursor, Claude Desktop, etc.) to your RouteCraft MCP server over stdio, configure the server with **the full path** to the `craft` executable. The client process often has a minimal `PATH`, so a bare `craft` command can fail with **"Failed to spawn process: No such file or directory"**.

**Node version:** The server requires **Node.js 18.19+ or 20+** (Pino 10 needs `diagnostics_channel.tracingChannel`). If the client spawns with an older Node (e.g. 18.17), the process will exit with a clear message. Fix it by using a newer Node for the MCP server:

- **Option A:** Start Cursor/Claude from a shell where a newer Node is first in `PATH` (e.g. run `nvm use 22` then open the app from that terminal).
- **Option B:** In MCP config, set **command** to the full path of a Node 20+ binary and **args** so the first element is the path to the **CLI’s JavaScript entry** (the `.js` file). This is the **recommended** approach; using the `craft` executable as `command` often fails because the MCP client has a minimal `PATH`. To get the CLI entry path: from a project that has `@routecraft/cli` installed, run `node -e "console.log(require.resolve('@routecraft/cli/dist/index.js'))"`.

   **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS) or **Cursor** (MCP settings):

   ```json
   {
     "mcpServers": {
       "routecraft": {
         "command": "/path/to/node",
         "args": [
           "/path/to/@routecraft/cli/dist/index.js",
           "run",
           "--log-file",
           "/path/to/craft.log",
           "--log-level",
           "debug",
           "/path/to/your/index.mjs"
         ]
       }
     }
   }
   ```

   Replace `/path/to/node` with the full path to your Node 20+ binary (e.g. from `which node`), the CLI and entry paths with your actual paths, and the log path if desired. Logging to a file keeps stdout JSON-RPC-only. To disable logs, use `--log-level silent`.

## Documentation

For comprehensive documentation, examples, and guides, visit [routecraft.dev](https://routecraft.dev).

## Example

```typescript
import { tool } from '@routecraft/ai';
import { craft, context, DirectAdapter } from '@routecraft/routecraft';
import { z } from 'zod';

craft()
  .from(
    tool('fetch-webpage', {
      description: 'Fetch and return the content of a webpage',
      schema: z.object({
        url: z.string().url(),
      }),
      keywords: ['fetch', 'web', 'http'],
    })
  )
  .process(async ({ url }) => {
    const response = await fetch(url);
    return { content: await response.text() };
  });

// After context.start(), query registered tools
const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
const tools = Array.from(registry?.values() ?? []);
```

## Contributing

Contributions are welcome! Please see our [Contributing Guide](https://github.com/routecraftjs/routecraft/blob/main/CONTRIBUTING.md).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)
