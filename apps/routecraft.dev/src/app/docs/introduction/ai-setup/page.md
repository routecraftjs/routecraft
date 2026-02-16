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

Define tools as routes using `tool()` from `@routecraft/ai`:

```typescript
import { craft, tool, noop } from '@routecraft/routecraft'
import { z } from 'zod'

export default craft()
  .id('my-tool')
  .from(tool('my-tool', {
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

## 4. Restart and verify

1. Completely quit and restart Claude/Cursor
2. Look for the hammer icon (🔨) in the input area
3. Your tools should appear in the tool picker

## Production deployment

For production MCP servers, use absolute paths:

```json
{
  "mcpServers": {
    "production-tools": {
      "command": "/usr/local/bin/node",
      "args": [
        "/path/to/project/node_modules/@routecraft/cli/dist/index.js",
        "run",
        "/path/to/project/routes/tools.mjs"
      ]
    }
  }
}
```

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
