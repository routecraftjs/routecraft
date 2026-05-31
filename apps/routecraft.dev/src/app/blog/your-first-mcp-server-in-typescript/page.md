---
title: Your first MCP server in TypeScript with Routecraft
description: A ten-minute walkthrough from `bunx create-routecraft` to a working MCP server that Claude Desktop and Cursor can call. No auth, no infrastructure, no boilerplate. Just a TypeScript function exposed to your AI agent.
date: 2026-05-29
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.6.0+'
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

This post sticks to stdio because that is the fastest path to a working setup.

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

- `notes_list` returns a list of notes, optionally filtered by query.
- `notes_create` adds a new note to an in-memory store.

The point is the shape, not the notes. Once you understand how a capability becomes a tool, the same pattern works for "list orders in Stripe", "search a Postgres table", "send a Slack message", or anything else you can call from a function.

End state:

![The MCP Inspector connected to the notebook server, showing the notes_list and notes_create tools](/images/blog/your-first-mcp-server-in-typescript/mcp-inspector-tools.png)

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

Now the `notes_list` capability. Create `capabilities/notes/list-notes/route.ts`:

```ts
// capabilities/notes/list-notes/route.ts
import { mcp } from '@routecraft/ai'
import { craft } from '@routecraft/routecraft'
import { z } from 'zod'

import { store } from '../_lib/store'

const ListNotesInput = z.object({
  query: z.string().optional(),
})
type ListNotesInput = z.infer<typeof ListNotesInput>

export default craft()
  .id('notes_list')
  .description('List notes, optionally filtered by a search query.')
  .input({ body: ListNotesInput })
  .from<ListNotesInput>(mcp())
  .transform((input) => store.list(input.query))
```

This is the entire tool. Let us read it line by line, because if you understand this you understand Routecraft:

- `craft()` starts a capability builder.
- `.id('notes_list')` is the tool name the AI sees. Pick something descriptive.
- `.description()` is what the AI reads to decide when to call this tool. Treat it as prompt engineering, not docs.
- `.input({ body: ListNotesInput })` is the Zod schema for the input. Routecraft validates against it before your code runs, so invalid calls are rejected with a structured error.
- `.from<ListNotesInput>(mcp())` says "this capability's source is an MCP call". That is what turns the capability into an MCP tool. The generic flows the input type through the chain so the transform is fully typed.
- `.transform((input) => ...)` is your business logic. The `input` argument is the validated body, already typed. (The transform also receives the full exchange as a second argument, which we use later for auth.)

That's the whole pattern: input schema in, transform out. Adapters on either end.

## Add the create tool

Same shape, different verb. Create `capabilities/notes/create-note/route.ts`:

```ts
// capabilities/notes/create-note/route.ts
import { mcp } from '@routecraft/ai'
import { craft } from '@routecraft/routecraft'
import { z } from 'zod'

import { store } from '../_lib/store'

const CreateNoteInput = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(10_000),
})
type CreateNoteInput = z.infer<typeof CreateNoteInput>

export default craft()
  .id('notes_create')
  .description('Create a new note with a title and body.')
  .input({ body: CreateNoteInput })
  .from<CreateNoteInput>(mcp())
  .transform((input) => store.create(input.title, input.body))
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

## Wire the routes into the entry point

`craft run` executes `index.ts`, and a fresh project starts with an empty route list. Point it at the capabilities you just registered:

```ts
// index.ts
export { craftConfig } from "./craft.config.js";
import capabilities from "./capabilities/index.js";

export default capabilities;
```

This is the one piece of glue between the files you wrote and the runner: `index.ts` re-exports the config from `craft.config.ts` and the routes from `capabilities/`.

## Inspect it with the MCP Inspector

The fastest way to see your tools is the official [MCP Inspector](https://github.com/modelcontextprotocol/inspector). It spawns your server and gives you a browser UI to list and call tools, with no client setup. From the project root:

```bash
npx @modelcontextprotocol/inspector bunx @routecraft/cli --log-level silent run index.ts
```

`--log-level silent` keeps stdout clean: a stdio MCP server uses stdout exclusively for protocol frames, so anything else printed there breaks the connection. The Inspector opens in your browser. Click **Connect**, then **List Tools**, and you should see `notes_list` and `notes_create`.

![The MCP Inspector listing the notebook server's notes_list and notes_create tools](/images/blog/your-first-mcp-server-in-typescript/mcp-inspector-tools.png)

Open `notes_create`, fill in a title and body, and **Run Tool**. Then run `notes_list` and you will see the note you just created. That round-trip is your MCP server working end to end.

## Use it in a real client

Once it works in the Inspector, any MCP client can call the same command. In Claude Desktop or Cursor, add an `mcpServers` entry that runs the server over stdio, pointing at the **absolute path** to your project's `index.ts`:

```json
{
  "mcpServers": {
    "notebook": {
      "command": "bunx",
      "args": [
        "@routecraft/cli",
        "--log-level",
        "silent",
        "run",
        "/absolute/path/to/notebook/index.ts"
      ]
    }
  }
}
```

Clients spawn the server with a minimal environment and do not expand `~`, so use absolute paths. Fully restart the client (quit, not just close the window) and the tools appear. Ask it: _"Create a note titled Groceries with body milk, bread, eggs, then list all notes"_ and it will call `notes_create` then `notes_list`.

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
- **Go to HTTP, with auth.** When you want this reachable from anywhere, not just your laptop, check our the [http transport](http://localhost:3000/docs/advanced/expose-as-mcp/#http-transport). 

The [Routecraft docs](/docs/introduction) cover all of the above in more depth.

## Try it without leaving your browser

If you want to play with the framework before installing anything, open the [Routecraft playground in GitHub Codespaces](https://codespaces.new/routecraftjs/craft-playground). Full terminal, hammer-ready in about thirty seconds.

```bash
# Or scaffold a new project locally
bunx create-routecraft my-app
```
