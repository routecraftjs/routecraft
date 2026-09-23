# @routecraft/ai

AI adapters and MCP integration for Routecraft. Call LLMs, run agents, generate embeddings, expose your capabilities to Claude, Cursor and other MCP clients, and talk to your agents from an editor over the Agent Client Protocol.

## Installation

```bash
# Bun (recommended)
bun add @routecraft/ai

# npm / pnpm / yarn
npm install @routecraft/ai
pnpm add @routecraft/ai
yarn add @routecraft/ai
```

The model provider SDKs (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, and the others) and the MCP SDK packages are optional peers, loaded lazily by the adapter that needs them. A missing one fails with `RC5017` naming the package to install.

## Quick Start

Define a capability and expose it as an MCP tool. The tool name is the route id, the description comes from `.description()`, and the input schema from `.input()`:

```typescript
// capabilities/fetch-webpage.ts
import { mcp, mcpPlugin } from '@routecraft/ai';
import { craft, ContextBuilder, http } from '@routecraft/routecraft';
import { z } from 'zod';

const ctx = new ContextBuilder()
  .plugins([mcpPlugin()])
  .routes([
    craft()
      .id('fetch-webpage')
      .description('Fetch and return the content of a webpage')
      .input({ body: z.object({ url: z.string().url() }) })
      .from(mcp())
      .enrich(http({ url: (ex) => ex.body.url })),
  ])
  .build();

await ctx.start();
```

Run it as an MCP server over stdio (requires Bun on the host):

```bash
bunx @routecraft/cli run capabilities/fetch-webpage.ts
```

## Three modes

### Server mode: expose capabilities outward via MCP

Use `mcp()` as a `.from()` source and register `mcpPlugin()` in the context. Every such route becomes an MCP tool that Claude Desktop, Cursor, or any MCP client can invoke, with the input validated against the route's schema before your code runs.

```typescript
import { mcp, mcpPlugin, llm, llmPlugin } from '@routecraft/ai';
import { craft, ContextBuilder, http } from '@routecraft/routecraft';
import { z } from 'zod';

const ctx = new ContextBuilder()
  .plugins([
    mcpPlugin(),
    llmPlugin({
      providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } },
    }),
  ])
  .routes([
    craft()
      .id('summarize-webpage')
      .description('Fetch and summarize the content of a webpage')
      .input({ body: z.object({ url: z.string().url() }) })
      .from(mcp())
      .enrich(http({ url: (ex) => ex.body.url }))
      .to(llm('anthropic:claude-sonnet-4-6', {
        system: 'Summarize the following webpage content concisely.',
        user: (ex) => String(ex.body),
      })),
  ])
  .build();
```

Over stdio nothing else is needed. To serve MCP over HTTP, declare a listener under `servers` in `craft.config.ts` and mount MCP on it; outside `development` and `test` the plugin also needs an explicit HTTPS `resource.url` so the protected-resource metadata it advertises is correct:

```typescript
import { defineConfig } from '@routecraft/routecraft';
import '@routecraft/ai';

export const craftConfig = defineConfig({
  servers: { public: { host: '0.0.0.0', port: 8080 } },
  mcp: { server: 'public', path: '/mcp' },
});
```

### Client mode: call other MCP servers and local capabilities

Register servers on `mcpPlugin({ clients })`, then call one of their tools with `mcp('server:tool')` (or `mcp({ url, tool })` for an ad-hoc server). Call a capability in the same process by id with `direct()`:

```typescript
import { craft, direct, timer } from '@routecraft/routecraft';
import { mcp } from '@routecraft/ai';

craft()
  .id('orchestrator')
  .from(timer({ interval: '1m' }))
  .enrich(mcp('search:web', { args: (ex) => ({ query: ex.body.query }) }))
  .to(direct('fetch-webpage'));
```

### Agent mode: an agent is a route too

`agent()` runs a tool-calling loop as a step in a route. Tools are an allowlist of your own capabilities (`Direct(<route-id>)`), registered MCP tools (`MCP(<server>:<tool>)`) and plain functions; nothing else is reachable.

```typescript
import { craft, direct } from '@routecraft/routecraft';
import { agent, agentPlugin, tools } from '@routecraft/ai';
import { z } from 'zod';

export default craft()
  .id('assistant')
  .description('Answer a question with the tools this project defines')
  .input({ body: z.object({ question: z.string() }) })
  .from(direct())
  .to(
    agent<{ question: string }>({
      model: 'anthropic:claude-opus-4-7',
      system: 'Be useful. Say what you did.',
      user: (ex) => ex.body.question,
      tools: tools(['Direct(fetch-webpage)']),
    }),
  );
```

Because the agent is a step, `.authorize()`, `.throttle()`, `.retry()`, `.timeout()` and `.circuitBreaker()` apply to the model call as to any other step. An agent can also be a markdown file under `agents/` with frontmatter for its model and tools, loaded by `agentPlugin({ agents })` or discovered by `craft start`.

- **Sessions.** `agent(name, { session })` keeps a durable transcript per session id, with an inbox and one turn at a time; `interrupt: true` cancels the running turn. Background tools (`directTool(id, { background: true })`) hand long work to a route and post the result to the session's inbox when it finishes.
- **Durable agents.** A tool that calls `ctx.defer()` defers the whole tool loop through the context's deferral store. The loop survives a restart and resumes mid-conversation, with the answer swapped into the tool result, when `.resume()` is called with the deferral's token.
- **Talk from your editor.** `acp:` on `defineConfig` (or `acpPlugin()`) serves the Agent Client Protocol beside MCP, and `craft acp` is the bridge an editor runs. The `surface()` adapter lets a capability ask the person in the editor a question and wait for the answer.

## Connecting Claude Desktop and Cursor

The CLI runs your capability file as an MCP server. Use `bunx` so clients do not need a global install; Bun 1.1.0 or later must be on the client's `PATH`, because the `craft` CLI is Bun-only and refuses to start under Node.

In **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS) or **Cursor** (MCP settings):

```json
{
  "mcpServers": {
    "routecraft": {
      "command": "bunx",
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

Use `@routecraft/cli@canary` for the latest canary build. Writing logs to a file keeps stdout JSON-RPC-only, which is required for the stdio transport. Use `--log-level silent` to disable logs entirely.

**If `bunx` is not on the MCP client's `PATH`:** set `command` to the full path of the `bun` binary (`which bun`) and the first `args` element to the installed CLI entry point, `<project>/node_modules/@routecraft/cli/dist/index.js`.

To run inside a Node application instead of through the CLI, embed `@routecraft/routecraft` with `ContextBuilder` as in the examples above; see [Programmatic Invocation](https://routecraft.dev/docs/advanced/programmatic-invocation).

## Features

- **`mcp(options?)`**: register the route as an MCP tool (server mode); **`mcp('server:tool')`** or **`mcp({ url, tool })`**: call a tool on an external MCP server (client mode)
- **`mcpPlugin(options?)`**: the MCP server (stdio or HTTP on a named server), registered clients, OAuth 2.1 resource-server metadata, tool annotations and icons
- **`llm(modelId, options?)`**: call any LLM provider from a pipeline, with `reasoning` and `providerOptions` controls. Supports Anthropic, OpenAI, Gemini, Ollama, OpenRouter, LM Studio and any custom AI SDK model. Register providers via `llmPlugin`.
- **`agent(options)` / `agent(name)`**, **`agentPlugin`**, **`agents()`**, **`tools()`**, **`directTool()`**, **`skills()`**: the agent runtime, sessions, durable deferral and the tool allowlist
- **`acpPlugin()`** and **`surface()`**: the Agent Client Protocol seam for editors
- **`embedding(modelId, options?)`**: generate embeddings from a pipeline
- **Schema validation**: Zod or any Standard Schema library validates MCP tool input before your code runs, and the advertised output schema is enforced on the way out
- **Error codes**: `AI1001` to `AI1019` (blocks, skills, agent runs, deferral, context window, sessions, editor surface) and `AI2001` / `AI2002` (MCP output contract, declined tool call). See the [errors reference](https://routecraft.dev/docs/reference/errors).

## Documentation

- [Expose as MCP](https://routecraft.dev/docs/advanced/expose-as-mcp) and [call an MCP](https://routecraft.dev/docs/advanced/call-an-mcp)
- [Agent adapter](https://routecraft.dev/docs/reference/adapters/agent) and [durable agents](https://routecraft.dev/docs/advanced/durable-agents)
- [Talk from your editor](https://routecraft.dev/docs/advanced/talk-from-your-editor)
- [LLM adapter](https://routecraft.dev/docs/reference/adapters/llm)

## Contributing

Contributions are welcome. See the [Contributing Guide](https://github.com/routecraftjs/routecraft/blob/main/CONTRIBUTING.md).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)
