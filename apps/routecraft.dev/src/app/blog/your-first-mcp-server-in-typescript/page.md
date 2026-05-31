---
title: Your first MCP server in TypeScript with Routecraft
description: A ten-minute walkthrough from `bunx create-routecraft` to a working MCP server that Claude Desktop and Cursor can call. No auth, no infrastructure, no boilerplate. Just a TypeScript function exposed to your AI agent.
date: 2026-05-18
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.5.0+'
draft: false
tags:
  - mcp
  - routecraft
  - typescript
  - claude-desktop
  - cursor
layout: blog-post
---

If you have heard of the Model Context Protocol and want a working server in front of Claude Desktop, Cursor, or your IDE's MCP client in about ten minutes, this post is for you. We will scaffold a TypeScript project, write a tool, run it locally, and connect an AI agent to call it. No auth, no Docker, no platform.

If you would rather start with the framework's own tour, the [Routecraft introduction](/docs/introduction) covers the same ground in reference form. This post is the narrative version, optimised for "I want to see it work in one tab".

## What MCP is, briefly

The [Model Context Protocol](https://modelcontextprotocol.io) is an open spec from Anthropic for connecting AI agents to your tools, data, and prompts. An MCP-capable client like Claude Desktop or Cursor can connect to any MCP server and call its tools with validated JSON inputs.

Two transports are supported:

- **stdio**: the agent spawns your server as a subprocess and communicates over stdin/stdout. Local only, no network, no auth.
- **HTTP**: your server runs as a network service. Authentication is required for anything sensitive.

This post sticks to stdio because that is the fastest path to a working setup. Once you are happy with the shape, the [Clerk auth post](/blog/securing-mcp-with-clerk) covers putting auth in front of an HTTP version of the same server.

## Why Routecraft for this

You can write an MCP server in raw TypeScript. The MCP SDK ships a low-level server abstraction, and Anthropic's docs walk through it. It works, and for one-off scripts it is fine. The pain shows up when:

- you want **typed inputs** validated before your tool runs,
- you want a tool to be both an **MCP tool now** and a **cron job later** without rewriting it,
- you want the same code to **log structured events**, retry on failure, and run a test suite without you bolting it on,
- you want to add **auth, rate limiting, or observability** later without rewriting your tools.

[Routecraft](/docs/introduction) is a TypeScript framework for exactly this shape. You write **capabilities**, which are small composable routes (`source -> operations -> destination`), and the runtime handles MCP transport, validation, logging, telemetry, and the awkward bits. Your tool is twenty lines of TypeScript that you can read in one sitting.

For comparison, a hand-rolled MCP tool that does input validation, structured logging, and error formatting is closer to eighty lines. Routecraft is doing real work for you.

## What we will build

A tiny **notebook** MCP server with two tools:

- `notes.list` returns a list of notes, optionally filtered by query.
- `notes.create` adds a new note to an in-memory store.

The point is the shape, not the notes. Once you understand how a capability becomes a tool, the same pattern works for "list orders in Stripe", "search a Postgres table", "send a Slack message", or anything else you can call from a function.

End state:

![Claude Desktop with the notebook MCP server connected, showing the notes.list tool ready to call](/images/blog/your-first-mcp-server-in-typescript/claude-desktop-tools.png)

## Prerequisites

You will need:

- **Bun** 1.1 or newer ([install instructions](https://bun.sh)). Routecraft works on Node 22+ too, but Bun is faster for the dev loop.
- **An MCP client.** Claude Desktop, Cursor, or any other client that speaks stdio MCP. Free downloads.
- **Five to ten minutes.**

That's it. No accounts, no API keys, no platform setup.

## Scaffold the project

```bash
bunx create-routecraft notebook
cd notebook
bun install
```

This drops you in a clean project with a `craft.config.ts` at the root and a `capabilities/` directory. Open it in your editor.

Add the MCP and validation packages:

```bash
bun add @routecraft/ai zod
```

`@routecraft/ai` provides the `mcp()` source adapter that turns a capability into an MCP tool. `zod` validates inputs before your tool ever runs.

## Write your first tool

A small in-memory store first. Create `capabilities/notes/_lib/store.ts`:

```ts
// capabilities/notes/_lib/store.ts
export interface Note {
  id: string
  title: string
  body: string
  createdAt: string
}

const notes: Note[] = []

export const store = {
  list(query?: string): Note[] {
    if (!query) return notes
    const q = query.toLowerCase()
    return notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.body.toLowerCase().includes(q),
    )
  },
  create(title: string, body: string): Note {
    const note: Note = {
      id: crypto.randomUUID(),
      title,
      body,
      createdAt: new Date().toISOString(),
    }
    notes.push(note)
    return note
  },
}
```

Now the `notes.list` capability. Create `capabilities/notes/list-notes/route.ts`:

```ts
// capabilities/notes/list-notes/route.ts
import { mcp } from '@routecraft/ai'
import { craft } from '@routecraft/routecraft'
import { z } from 'zod'

import { store } from '../_lib/store'

export default craft()
  .id('notes.list')
  .description('List notes, optionally filtered by a search query.')
  .input({
    body: z.object({
      query: z.string().optional(),
    }),
  })
  .from(mcp())
  .transform(({ body }) => store.list(body.query))
```

This is the entire tool. Let us read it line by line, because if you understand this you understand Routecraft:

- `craft()` starts a capability builder.
- `.id('notes.list')` is the tool name the AI sees. Pick something descriptive.
- `.description()` is what the AI reads to decide when to call this tool. Treat it as prompt engineering, not docs.
- `.input({ body: z.object(...) })` is the Zod schema for the input. Routecraft validates against this schema before your code runs, so invalid calls are rejected with a structured error.
- `.from(mcp())` says "this capability's source is an MCP call". That is what turns the capability into an MCP tool.
- `.transform(({ body }) => ...)` is your business logic. The `body` argument is the validated input, already typed.

That's the whole pattern: input schema in, transform out. Adapters on either end.

## Add the create tool

Same shape, different verb. Create `capabilities/notes/create-note/route.ts`:

```ts
// capabilities/notes/create-note/route.ts
import { mcp } from '@routecraft/ai'
import { craft } from '@routecraft/routecraft'
import { z } from 'zod'

import { store } from '../_lib/store'

export default craft()
  .id('notes.create')
  .description('Create a new note with a title and body.')
  .input({
    body: z.object({
      title: z.string().min(1).max(120),
      body: z.string().min(1).max(10_000),
    }),
  })
  .from(mcp())
  .transform(({ body }) => store.create(body.title, body.body))
```

Register both in `capabilities/index.ts`:

```ts
// capabilities/index.ts
import listNotes from './notes/list-notes/route'
import createNote from './notes/create-note/route'

export default [listNotes, createNote]
```

## Wire the MCP transport

Open `craft.config.ts` and replace it with:

```ts
// craft.config.ts
import { mcpPlugin } from '@routecraft/ai'
import { defineConfig } from '@routecraft/routecraft'

export const craftConfig = defineConfig({
  name: 'notebook',
  plugins: [
    mcpPlugin({
      name: 'notebook',
      version: '0.1.0',
      transport: 'stdio',
    }),
  ],
})
```

`transport: 'stdio'` tells Routecraft to speak MCP over stdin/stdout. That is the format MCP clients like Claude Desktop expect when they spawn a server as a subprocess. No ports, no networking.

## Run it

```bash
bun run craft run
```

You should see Routecraft start, register both tools, and wait for stdio input. It will not print much, because every byte on stdout is reserved for MCP protocol frames. Logs go to stderr.

Leave it running for the moment.

## Connect from Claude Desktop

Find your Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

If the file does not exist, create it. Add an `mcpServers` entry:

```json
{
  "mcpServers": {
    "notebook": {
      "command": "bunx",
      "args": [
        "@routecraft/cli",
        "run",
        "/absolute/path/to/notebook/capabilities"
      ]
    }
  }
}
```

Use the **absolute path** to your `notebook` directory. Claude Desktop will not expand `~` or relative paths.

Quit Claude Desktop completely (not just the window, the whole app) and reopen it. In a new conversation, look for the hammer icon in the input area, click it, and you should see `notes.list` and `notes.create` listed.

![Claude Desktop showing the hammer icon expanded with the notebook MCP server's two tools visible](/images/blog/your-first-mcp-server-in-typescript/claude-desktop-tools.png)

Ask Claude something like:

> Create a note titled "Groceries" with body "milk, bread, eggs", then list all notes.

Claude will call `notes.create` first, then `notes.list`, and show you the result. You just wrote an MCP server.

## Connect from Cursor

Almost identical. Open **Cursor Settings -> Features -> Model Context Protocol** and add:

```json
{
  "notebook": {
    "command": "bunx",
    "args": [
      "@routecraft/cli",
      "run",
      "/absolute/path/to/notebook/capabilities"
    ]
  }
}
```

Restart Cursor. The tools show up in chat the same way.

## What you got for the twenty lines

This is the moment to call out what Routecraft did under the hood, because it is genuinely a lot:

- **MCP protocol framing.** All the JSON-RPC handshake, capability discovery, tool listing, and error formatting.
- **Input validation.** Your Zod schema is enforced before `transform` runs. Invalid inputs become structured MCP errors automatically.
- **Type safety.** Inside `transform`, `body` is already typed as `{ query?: string }`. No casting, no `as`.
- **Structured logging.** Tool calls, inputs, outputs, durations, errors. All logged to stderr in a structured format you can pipe to a log aggregator later.
- **Graceful shutdown.** When the MCP client disconnects, Routecraft cleans up cleanly. No zombie processes.

If you wrote this in raw Node with the MCP SDK you would be writing each of those by hand. None of it is hard. All of it is annoying. Routecraft's pitch is "the boring parts are done so you write only the part that is yours".

## Where to go from here

A few natural next steps:

- **Add a real data source.** Swap the in-memory `store` for a SQLite database, a Postgres query, or an HTTP API. Routecraft has [adapters](/docs/introduction/adapters) for all three.
- **Run it as a cron job too.** Change `.from(mcp())` to `.from(cron('0 9 * * *'))` and the same capability runs every morning at 9. No other code changes.
- **Compose capabilities.** `direct()` lets one capability call another with type safety. Build a graph, test each node in isolation.
- **Go to HTTP, with auth.** When you want this reachable from anywhere, not just your laptop, follow the [Clerk MCP auth](/blog/securing-mcp-with-clerk) post.

The [Routecraft docs](/docs/introduction) cover all of the above in more depth.

## Try it without leaving your browser

If you want to play with the framework before installing anything, open the [Routecraft playground in GitHub Codespaces](https://codespaces.new/routecraftjs/craft-playground). Full terminal, hammer-ready in about thirty seconds.

```bash
# Or scaffold a new project locally
bunx create-routecraft my-app
```
