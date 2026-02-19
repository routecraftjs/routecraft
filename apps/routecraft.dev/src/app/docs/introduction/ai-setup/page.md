---
title: AI & MCP Setup
---

Connect RouteCraft to Claude Desktop, Cursor, or other MCP clients. {% .lead %}

## Overview

RouteCraft integrates with AI agents through the Model Context Protocol (MCP). You define tools as routes, then expose them to AI clients like Claude Desktop or Cursor.

**Security model:**
- AI can only call the tools you explicitly define
- Each tool has a typed schema (validated with Zod)
- No filesystem access, no shell commands
- You control all business logic

## 1. Install the AI package

```bash
npm install @routecraft/ai zod
```

## 2. Create tools

Define tools as routes using `mcp()` from `@routecraft/ai`:

```typescript
import { mcp } from '@routecraft/ai'
import { craft, noop } from '@routecraft/routecraft'
import { z } from 'zod'

export default craft()
  .id('my-tool')
  .from(mcp('my-tool', {
    description: 'What this tool does',
    schema: z.object({
      param: z.string()
    }),
    keywords: ['search', 'terms']
  }))
  .process((body) => {
    // Your business logic
    return { result: body.param }
  })
  .to(noop())
```

## 3. Configure MCP client

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "my-business-tools": {
      "command": "npx",
      "args": [
        "@routecraft/cli",
        "run",
        "./routes/tools.mjs"
      ]
    }
  }
}
```

### Cursor

Open Cursor Settings → Features → Model Context Protocol, then add:

```json
{
  "my-business-tools": {
    "command": "npx",
    "args": [
      "@routecraft/cli",
      "run",
      "./routes/tools.mjs"
    ]
  }
}
```

## Calling external MCP servers (optional)

If your routes need to **call** another MCP server (e.g. a browser MCP for automation), add the MCP plugin with **clients** so the adapter can resolve server URLs:

```ts
import { mcpPlugin } from '@routecraft/ai';

craft().with({
  plugins: [
    mcpPlugin({
      clients: {
        browser: { url: 'http://127.0.0.1:8089/mcp' },
      },
    },
  ],
})
```

Then use `.to(mcp('browser:toolName', { args: () => ({ ... }) }))` or `.enrich(mcp('browser:toolName', ...))` in your routes. See [AI reference – MCP client](/docs/reference/ai#mcp-client-calling-remote-mcp-tools) for full options and patterns.

## 4. Restart and verify

1. Completely quit and restart Claude/Cursor
2. Look for the hammer icon (🔨) in the input area
3. Your tools should appear in the tool picker

## Production deployment

For production, we recommend **npx** with a pinned version (e.g. `@routecraft/cli@2.0.0`) so you don’t rely on global installs or path resolution:

```json
{
  "mcpServers": {
    "production-tools": {
      "command": "npx",
      "args": [
        "@routecraft/cli@2.0.0",
        "run",
        "/path/to/project/routes/tools.mjs"
      ]
    }
  }
}
```

If npx is not available in your environment, use the full path to Node and to `node_modules/@routecraft/cli/dist/index.js` as the first arg.

## Security best practices

1. **Validate all inputs** - Use Zod schemas on every tool
2. **Principle of least privilege** - Only expose tools AI needs
3. **Audit logs** - Use `.tap(log())` to track tool usage
4. **Rate limiting** - Add throttling for sensitive operations
5. **Environment variables** - Never hardcode API keys

## Next steps

- [Tool reference](/docs/reference/ai)
- [AI examples](/docs/examples/ai-agent-tools)
- [Testing routes](/docs/introduction/testing)
