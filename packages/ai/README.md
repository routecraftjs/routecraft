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

**Recommended:** use **npx** so the MCP client runs the CLI without needing a global install or full paths. The server requires **Node.js 18.19+ or 20+** (Pino 10 needs `diagnostics_channel.tracingChannel`). If the client uses an older Node, start Cursor/Claude from a shell where a newer Node is first in `PATH` (e.g. `nvm use 22`), or set **command** to the full path of a Node 20+ binary and **args** with the path to the CLI entry (see fallback below).

In **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS) or **Cursor** (MCP settings):

```json
{
  "mcpServers": {
    "routecraft": {
      "command": "npx",
      "args": [
        "@routecraft/cli",
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

Use `@routecraft/cli@canary` for the latest canary build. Logging to a file keeps stdout JSON-RPC-only; omit `--log-file` / `--log-level` or use `--log-level silent` to disable logs.

**Fallback (minimal PATH):** if `npx` is not available to the MCP client, set **command** to the full path of a Node 20+ binary and **args** so the first element is the CLI’s JavaScript entry. From a project with `@routecraft/cli` installed: `node -e "console.log(require.resolve('@routecraft/cli/dist/index.js'))"`.

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
