---
title: Building an authenticated MCP server with Routecraft and Clerk
description: A step-by-step guide to writing TypeScript capabilities, exposing them over the Model Context Protocol, and putting Clerk in front of them with OAuth 2.1 and JWKS verification.
date: 2026-05-26
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.6.0+'
draft: true
tags:
  - mcp
  - clerk
  - authentication
  - routecraft
  - typescript
featured: false
layout: blog-post
---

If you have Googled how to put Clerk in front of an MCP server, you have probably hit the same wall I did: the MCP spec wants OAuth 2.1 with Dynamic Client Registration, Clerk speaks both, but wiring the two together is more than a copy-paste from either set of docs. There is a discovery document to expose, a token verifier to set up, a Dynamic Client Registration lookup to handle, and a question about where the proxy endpoints live.

This post shows the working integration in about sixty lines of TypeScript using [Routecraft](/docs/introduction), a code-first automation framework that handles the MCP transport, the JWKS verification, and the auth plumbing for you. The same code is in production on DevOptix's internal MCP server, simplified here to a generic notes example you can copy and modify.

If you already have an MCP server and just need the Clerk auth bit, you can skip to [Wiring Clerk into the MCP plugin](#wiring-clerk-into-the-mcp-plugin). If MCP is new to you, [Build your first MCP server](/blog/your-first-mcp-server-in-typescript) is the prequel.

## A short primer on MCP

The [Model Context Protocol](https://modelcontextprotocol.io) is an open spec from Anthropic for connecting AI agents to tools, data, and prompts. A capable client like Claude Desktop, Cursor, or VS Code can connect to any MCP server and call its tools with validated JSON inputs.

MCP supports two transports:

- **stdio**: the agent spawns the server as a subprocess. No network, no auth.
- **HTTP**: the server runs as a network service. Authentication is required for anything sensitive.

Stdio is great for local-only tools. HTTP is what you reach for when:

- the server holds API keys or talks to a database you do not want every agent on the laptop to share,
- multiple users (humans, other agents) need to call the same server,
- you want to deploy the server once and connect from anywhere.

In HTTP mode, the MCP spec aligns with OAuth 2.1: clients obtain a bearer token from an authorization server, then attach it to every JSON-RPC request. The MCP server's job is to validate that token and decide what the bearer is allowed to do.

## What is Routecraft

Routecraft is a code-first automation framework for TypeScript. You write **capabilities** as small composable routes (think `source -> operations -> destination`), and the runtime takes care of scheduling, retries, observability, and adapter wiring. The killer feature for this post: any capability can be exposed as an MCP tool by setting its source to `mcp()`. The Routecraft runtime then publishes a fully-typed MCP server with auth, transport, and tool discovery handled for you.

If you have not seen Routecraft before, the [introduction](/docs/introduction) is worth a five minute scan before we continue.

## What we are building

A tiny **notebook MCP server** with two tools:

- `notes_list` returns notes belonging to the calling user.
- `notes_create` creates a new note for the calling user.

The point is the auth wiring, not the notes. The same pattern works for any tools you bolt onto Routecraft.

The flow we want at the end:

1. Claude Desktop connects to `https://notebook.example.com/mcp`.
2. The server returns an OAuth 2.0 Protected Resource metadata document pointing at Clerk.
3. Claude opens a browser, the user signs in to Clerk, Clerk issues a token.
4. Claude calls `notes_list` with the bearer token attached.
5. Routecraft verifies the token against Clerk's JWKS, hydrates a `principal` from the claims, then runs the capability.

![Diagram of the OAuth flow from Claude Desktop to Routecraft via Clerk](/images/blog/securing-mcp-with-clerk/flow.png)

## Project setup

Scaffold a new Routecraft project:

```bash
bunx create-routecraft notebook
cd notebook
bun install
```

Add the MCP and validation packages:

```bash
bun add @routecraft/ai zod
```

Open the project. You will see a `craft.config.ts` at the root and a `capabilities/` directory. We will write our two tools in `capabilities/notes/` and configure auth in `craft.config.ts`.

## A capability without auth

Let us start with the simplest possible version, so we have something to protect.

Create a tiny in-memory store in `capabilities/notes/_lib/store.ts`:

```ts
// capabilities/notes/_lib/store.ts
export interface Note {
  id: string
  ownerId: string
  title: string
  body: string
  createdAt: string
}

const notes = new Map<string, Note[]>()

export const store = {
  listByOwner(ownerId: string, query?: string): Note[] {
    const list = notes.get(ownerId) ?? []
    if (!query) return list
    const q = query.toLowerCase()
    return list.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.body.toLowerCase().includes(q),
    )
  },
  create(ownerId: string, title: string, body: string): Note {
    const note: Note = {
      id: crypto.randomUUID(),
      ownerId,
      title,
      body,
      createdAt: new Date().toISOString(),
    }
    const list = notes.get(ownerId) ?? []
    list.push(note)
    notes.set(ownerId, list)
    return note
  },
}
```

Now the `notes_list` capability:

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
  .description('List notes belonging to the calling user, optionally filtered by query.')
  .input({ body: ListNotesInput })
  .from<ListNotesInput>(mcp())
  .transform((input) => {
    // No auth yet: everyone shares the same bucket
    return store.listByOwner('anonymous', input.query)
  })
```

And `notes_create`:

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
  .description('Create a new note for the calling user.')
  .input({ body: CreateNoteInput })
  .from<CreateNoteInput>(mcp())
  .transform((input) => store.create('anonymous', input.title, input.body))
```

Register both in `capabilities/index.ts`:

```ts
import listNotes from './notes/list-notes/route'
import createNote from './notes/create-note/route'

export default [listNotes, createNote]
```

Wire the MCP transport in `craft.config.ts`:

```ts
import { mcpPlugin } from '@routecraft/ai'
import { defineConfig } from '@routecraft/routecraft'

export const craftConfig = defineConfig({
  plugins: [
    mcpPlugin({
      name: 'notebook',
      version: '0.1.0',
      transport: 'http',
      host: 'localhost',
    }),
  ],
})
```

Then point the entry point at your routes. `craft run` executes `index.ts`, which re-exports the config and the capabilities:

```ts
// index.ts
export { craftConfig } from "./craft.config.js";
import capabilities from "./capabilities/index.js";

export default capabilities;
```

Start it:

```bash
bun run start
```

You now have an unauthenticated MCP server listening on `http://localhost:3001/mcp`. That is fine for a five second smoke test, but it is also exactly what we do not want to ship.

## Why we need auth (and why bearer tokens, specifically)

Three reasons in increasing order of seriousness:

1. Every tool we add gets the access of the process. Database creds, OAuth tokens, GitHub PATs, anything the server holds is a tool away.
2. MCP tools are not just queries. `notes_create` writes. Future tools will send emails, hit production APIs, move money.
3. We want **per-user** behavior. `notes_list` should return the calling user's notes, not a shared bag.

The MCP spec settles on OAuth 2.1 bearer tokens. The client asks an authorization server (Clerk, in our case) for a token, then attaches it to every JSON-RPC call with an `Authorization: Bearer ...` header. The server's only job is to:

1. Verify the token's signature against the issuer's JWKS.
2. Check the audience and expiry.
3. Extract a principal (the user's ID, email, roles) from the claims.
4. Decide if that principal is allowed to call this tool.

Routecraft has a primitive for steps 1 through 3 (`jwks()`) and a primitive for step 4 (`.authorize()`). Clerk gives us the issuer side.

## Setting up Clerk

If you do not have a Clerk account, [sign up](https://dashboard.clerk.com/sign-up). It is free for the volumes we care about here.

### Create an application

In the Clerk dashboard, click **Create application**. Pick a name (I am using "Notebook" in this post) and the auth methods you want (email + Google is a sensible default). Click **Create application**.

![Clerk dashboard, Create application form with name and provider toggles](/images/blog/securing-mcp-with-clerk/clerk-create-app.png)

### Grab your keys

In the new app, open **API keys**. Copy two values:

- **Publishable key**, starting with `pk_test_...` or `pk_live_...`
- **Secret key**, starting with `sk_test_...` or `sk_live_...`

![Clerk dashboard, API keys page showing publishable and secret keys](/images/blog/securing-mcp-with-clerk/clerk-api-keys.png)

Drop them into a `.env` file in the project root:

```bash
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
MCP_HOST=localhost
MCP_ISSUER_URL=http://localhost:3001
```

`MCP_ISSUER_URL` is the public URL of the MCP server itself. For local development that is `http://localhost:3001`. In production it is whatever URL Claude or Cursor will be hitting.

### Enable OAuth applications

Clerk supports OAuth 2.1 Dynamic Client Registration through its **OAuth applications** feature. This is what lets Claude Desktop register itself as a client automatically the first time it connects.

Open **Configure -> OAuth applications** in the dashboard, then enable the feature. You do not need to create an app yourself, Claude will do that on first connect.

![Clerk dashboard, OAuth applications settings with Dynamic Client Registration enabled](/images/blog/securing-mcp-with-clerk/clerk-oauth-apps.png)

That is all the dashboard work. The rest is code.

## Wiring Clerk into the MCP plugin

Routecraft splits the server-side OAuth work in two:

1. The MCP plugin advertises a public OAuth 2.0 Protected Resource metadata document at `/.well-known/oauth-protected-resource` (driven by the `resource` option), pointing clients at the authorization server.
2. The `oauth()` helper mounts the authorization-server discovery document and proxy endpoints (`/authorize`, `/token`, `/register`) that forward to Clerk, so MCP clients can rely on a single URL without worrying about cross-origin issues.

It pairs with `jwks()`, which verifies incoming bearer tokens against Clerk's JSON Web Key Set.

Update `craft.config.ts`:

```ts
import { jwks, mcpPlugin, oauth } from '@routecraft/ai'
import { defineConfig } from '@routecraft/routecraft'

import { env } from './env'

// Clerk's frontend API URL is encoded inside the publishable key.
const CLERK_BASE = `https://${Buffer.from(
  env.CLERK_PUBLISHABLE_KEY.replace(/^pk_(test|live)_/, ''),
  'base64',
)
  .toString('utf8')
  .replace(/\$$/, '')}`

export const craftConfig = defineConfig({
  plugins: [
    mcpPlugin({
      name: 'notebook',
      title: 'Notebook',
      version: '0.1.0',
      transport: 'http',
      host: env.MCP_HOST,
      resource: { url: `${env.MCP_ISSUER_URL}/mcp` },
      auth: oauth({
        endpoints: {
          authorizationUrl: `${CLERK_BASE}/oauth/authorize`,
          tokenUrl: `${CLERK_BASE}/oauth/token`,
          registrationUrl: `${CLERK_BASE}/oauth/register`,
        },
        verify: jwks({
          jwksUrl: `${CLERK_BASE}/.well-known/jwks.json`,
          issuer: CLERK_BASE,
          audience: '*',
        }),
        client: async (clientId) => {
          const res = await fetch(
            `https://api.clerk.com/v1/oauth_applications?client_id=${encodeURIComponent(clientId)}`,
            { headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` } },
          )
          if (!res.ok) {
            throw new Error(`Clerk OAuth app lookup failed: ${res.status}`)
          }
          const list = (await res.json()) as {
            data: Array<{
              client_id: string
              name?: string
              client_secret?: string
              redirect_uris?: string[]
            }>
          }
          const app = list.data[0]
          if (!app) return undefined
          return {
            client_id: app.client_id,
            client_name: app.name,
            client_secret: app.client_secret,
            redirect_uris: app.redirect_uris ?? [],
          }
        },
      }),
    }),
  ],
})
```

And a typed `env.ts` so we fail fast on missing config:

```ts
// env.ts
import { z } from 'zod'

const schema = z.object({
  CLERK_PUBLISHABLE_KEY: z.string().startsWith('pk_'),
  CLERK_SECRET_KEY: z.string().startsWith('sk_'),
  MCP_HOST: z.string().default('localhost'),
  MCP_ISSUER_URL: z.url().default('http://localhost:3001'),
})

export const env = schema.parse(process.env)
```

A few things worth calling out:

- **`CLERK_BASE` is derived from the publishable key.** Clerk encodes the frontend API host inside the key, so you do not have to set it separately. This is the same trick the Clerk SDK uses internally.
- **`audience: '*'`** is permissive on purpose. Clerk tokens are issued for a specific Clerk instance, not our MCP server, so we accept any audience as long as the issuer and signature match. If you want stricter checks, set `audience` to a value you mint into a Clerk JWT template.
- **`client` is the bridge to Dynamic Client Registration.** When Claude registers itself, Routecraft needs to validate the resulting `client_id`. We look it up via Clerk's REST API. This is the one spot where Clerk's OAuth applications feature does the heavy lifting for us.

### What Routecraft just did for you

It is worth pausing here, because that config is short for a reason. Under the hood, those few lines stand in for everything you would otherwise hand-write against a raw Node server. Routecraft is:

- Serving the OAuth 2.0 Protected Resource metadata at `/.well-known/oauth-protected-resource`.
- Proxying the `authorize`, `token`, and `register` endpoints through to Clerk.
- Verifying every bearer token against Clerk's JWKS and attaching the resolved principal to the exchange.
- Running the MCP JSON-RPC handler: envelope parsing, tool dispatch, input validation, MCP-shaped error frames, and session management.

Hand-rolled with Express and `jose`, that is roughly 80 lines of boilerplate before your first tool, and it still does not include the structured logging, per-tool authorization gate, and Dynamic Client Registration validation you get here. The cost was never the lines; it is keeping all of it correct as the MCP spec and your tool surface evolve.

The Routecraft version is what you write. Everything else is what you do not.

Restart the server. Then hit the discovery endpoint:

```bash
curl http://localhost:3001/.well-known/oauth-protected-resource
```

You should see a JSON document with `authorization_servers` pointing back at your own server, which proxies the actual OAuth flow through to Clerk. That document is how MCP clients learn where to send the user.

## Connecting from Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (or the Windows equivalent):

```json
{
  "mcpServers": {
    "notebook": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

Restart Claude Desktop. The first time you trigger a notebook tool, Claude opens your browser to Clerk's hosted sign-in page. Sign in, approve the connection, and Claude swaps the resulting authorization code for an access token. From that point on, the token rides along with every tool invocation.

![Claude Desktop showing the notebook MCP tools after the Clerk sign-in flow completes](/images/blog/securing-mcp-with-clerk/claude-desktop-connected.png)

The Cursor flow is identical, just configured under **Settings -> Features -> MCP**.

## Hydrating a principal from the token

The capability code we wrote earlier hard-codes `'anonymous'` as the owner. Now that we have a real authenticated user, we can pull their ID off the verified token. Routecraft attaches a `principal` to every authenticated exchange:

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
  .description('List notes belonging to the calling user, optionally filtered by query.')
  .input({ body: ListNotesInput })
  .from<ListNotesInput>(mcp())
  .transform((input, exchange) => {
    const userId = exchange.principal?.subject
    if (!userId) {
      throw new Error('Unauthenticated')
    }
    return store.listByOwner(userId, input.query)
  })
```

`principal.subject` is the Clerk user ID (the `sub` claim on the JWT). Clerk also gives us `claims.email`, `claims.org_id`, and any custom claims you bake into a JWT template.

## Authorizing per tool with roles

Authentication says "this token is valid". Authorization says "this user is allowed to call this tool". For that, Routecraft has `.authorize()`:

```ts
const CreateNoteInput = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(10_000),
})
type CreateNoteInput = z.infer<typeof CreateNoteInput>

export default craft()
  .id('notes_create')
  .description('Create a new note for the calling user.')
  .input({ body: CreateNoteInput })
  .authorize({ roles: ['member'] })
  .from<CreateNoteInput>(mcp())
  .transform((input, exchange) => {
    const userId = exchange.principal!.subject
    return store.create(userId, input.title, input.body)
  })
```

Note where `.authorize()` sits: before `.from()`, not after. Like `.id()` and `.description()`, it stages metadata onto the route being declared, and the check runs at route entry before any pipeline step.

If the principal does not carry a `member` role, the capability throws before any business logic runs, and Routecraft returns an MCP error to the client.

Where do those roles come from? Two options with Clerk:

1. **Organization roles**: Clerk's organizations feature attaches roles to users. They land in the token as `claims.org_role` (a single string) or, with a JWT template, as a custom roles array.
2. **Public metadata**: You can stash `roles: ["member"]` in a user's public metadata and surface it via a JWT template.

Either way, you teach Routecraft how to read them by passing a `userinfo` callback to the plugin:

```ts
mcpPlugin({
  // ...
  userinfo: async (principal) => {
    const role = principal.claims?.org_role
    return {
      email: principal.claims?.email,
      roles: typeof role === 'string' ? [role] : undefined,
    }
  },
  auth: oauth({ /* ... */ }),
})
```

Now `.authorize({ roles: ['member'] })` has something to check against.

## Production checklist

Before pointing real traffic at this, a few things to lock down:

- **Set `MCP_ISSUER_URL` to your public URL.** Clients use this for redirect URIs. A wrong value here breaks the sign-in flow in subtle, hard-to-debug ways.
- **Use a live Clerk instance, not a test one.** Test instances are rate-limited and refuse some traffic.
- **Lock CORS to your client origins.** The MCP plugin accepts a `cors` option; default to `{ origin: false }` once you know who is calling.
- **Tighten the audience.** A Clerk JWT template that mints `aud: "notebook"` lets you set `audience: 'notebook'` in `jwks()` and reject tokens issued for other apps in the same Clerk instance.
- **Log what you reject.** A 401 with no logs is the worst kind of bug to ship. Routecraft's structured logger gives you `principal.subject` on success and the reason on failure.
- **Decide what happens when Clerk is down.** The `client` callback hits Clerk's API on every Dynamic Client Registration. Wrap it in a cache if your MCP server has any meaningful client churn.

## Common pitfalls

A few traps I have walked into:

- **`localhost` vs `127.0.0.1`** in `MCP_ISSUER_URL`. Pick one and stick with it. Clerk rejects redirect URIs that do not exactly match.
- **Token audience mismatches** when you forget to set `audience: '*'` and the token does not carry your expected `aud`.
- **JWKS caching**. Clerk rotates keys. If you cache JWKS yourself, respect the `Cache-Control` headers. Routecraft's `jwks()` does this for you.
- **Forgetting Dynamic Client Registration**. If `/register` is not enabled in Clerk, every new MCP client breaks the first time it connects.

## What's next

This wires Clerk in as the authorization server, with Routecraft acting as a thin OAuth proxy plus a JWKS verifier. It is a clean fit for small teams and side projects: one dashboard, one set of keys, no custom auth code.

Next in this series, we will secure the same server with [WorkOS AuthKit](https://workos.com/docs/authkit), where WorkOS hosts the OAuth flow and Routecraft drops the proxy to run as a pure validator. That post is still in the works.

## Try it without leaving your browser

The fastest way to see this working is the [Routecraft playground in GitHub Codespaces](https://codespaces.new/routecraftjs/craft-playground). Full terminal, ready in about thirty seconds, no install. Add a `.env` file with your Clerk keys and `bun run craft run` is one command away.

Or scaffold a project locally:

```bash
bunx create-routecraft my-mcp-server
```

Full docs at [routecraft.dev/docs](/docs/introduction). The MCP and auth primitives live in [`@routecraft/ai`](/docs/advanced/expose-as-mcp), and the vendor-neutral auth guide is [Securing capabilities](/docs/advanced/securing-capabilities).