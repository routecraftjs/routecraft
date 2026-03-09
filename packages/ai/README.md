# @routecraft/ai

AI adapters and MCP integration for RouteCraft. Call LLMs, run agents, generate embeddings, and expose your capabilities to Claude, Cursor, and other MCP clients.

## Installation

```bash
npm install @routecraft/ai
```

or

```bash
pnpm add @routecraft/ai
```

## Quick Start

Define a capability and expose it as an MCP tool:

```typescript
// capabilities/fetch-webpage.ts
import { mcp } from '@routecraft/ai';
import { craft, context, http } from '@routecraft/routecraft';
import { z } from 'zod';

const ctx = context()
  .routes([
    craft()
      .id('fetch-webpage')
      .from(
        mcp('fetch-webpage', {
          description: 'Fetch and return the content of a webpage',
          schema: z.object({ url: z.string().url() }),
        })
      )
      .enrich(http({ url: (ex) => ex.body.url })),
  ])
  .build();

await ctx.start();
```

Run it as an MCP server:

```bash
npx @routecraft/cli run capabilities/fetch-webpage.ts
```

## Two Modes

### Server Mode: expose capabilities outward via MCP

Use `mcp()` as a `.from()` source. This registers the capability as an MCP tool that Claude Desktop, Cursor, or any MCP client can invoke.

```typescript
import { mcp, llm, llmPlugin } from '@routecraft/ai';
import { craft, context, http } from '@routecraft/routecraft';
import { z } from 'zod';

const ctx = context()
  .plugins([
    llmPlugin({
      providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } },
    }),
  ])
  .routes([
    craft()
      .id('summarize-webpage')
      .from(
        mcp('summarize-webpage', {
          description: 'Fetch and summarize the content of a webpage',
          schema: z.object({ url: z.string().url() }),
        })
      )
      .enrich(http({ url: (ex) => ex.body.url }))
      .to(llm('anthropic:claude-sonnet-4-6', {
        systemPrompt: 'Summarize the following webpage content concisely.',
        userPrompt: (ex) => String(ex.body),
      })),
  ])
  .build();
```

### Client Mode: route data to agents in code

Use `mcp()` as a `.to()` destination to call another MCP server, or use `direct()` to call a capability in the same process by ID.

```typescript
import { direct, timer } from '@routecraft/routecraft';

// Call a capability in the same process on a schedule
craft()
  .id('orchestrator')
  .from(timer({ intervalMs: 60_000 }))
  .to(direct('fetch-webpage'));
```

## Connecting Claude Desktop and Cursor

The CLI runs your capability file as an MCP server. Use `npx` so clients do not need a global install.

**Node.js 18.19+ or 20+** is required.

In **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS) or **Cursor** (MCP settings):

```json
{
  "mcpServers": {
    "routecraft": {
      "command": "npx",
      "args": [
        "@routecraft/cli",
        "run",
        "--log-file", "/path/to/craft.log",
        "--log-level", "debug",
        "/path/to/your/capabilities/index.ts"
      ]
    }
  }
}
```

Use `@routecraft/cli@canary` for the latest canary build. Writing logs to a file keeps stdout JSON-RPC-only, which is required for MCP transport. Use `--log-level silent` to disable logs entirely.

**If `npx` is not available to the MCP client:** set `command` to the full path of a Node 20+ binary and set the first `args` element to the CLI entry point. From a project with `@routecraft/cli` installed, find it with:

```bash
node -e "console.log(require.resolve('@routecraft/cli/dist/index.js'))"
```

## Features

- **`mcp(name, options)`**: Register a capability as an MCP tool (server mode) or call an external MCP server (client mode)
- **`llm(modelId, options?)`**: Call any LLM provider from a capability pipeline. Supports Anthropic, OpenAI, Gemini, Ollama, and OpenRouter. Register providers via `llmPlugin`.
- **`embedding(modelId, options?)`**: Generate embeddings from a capability pipeline.
- **Schema validation**: Use Zod (or any Standard Schema library) for strict input validation on MCP tools
- **Tool discovery**: Registered tools are available via the context store for querying endpoints, descriptions, and schemas

## Documentation

For full guides and examples, visit [routecraft.dev](https://routecraft.dev).

## Contributing

Contributions are welcome. See the [Contributing Guide](https://github.com/routecraftjs/routecraft/blob/main/CONTRIBUTING.md).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)
