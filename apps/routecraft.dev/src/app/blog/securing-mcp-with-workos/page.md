---
title: Migrating an MCP server from Clerk to WorkOS AuthKit
description: Dropping the OAuth proxy and running Routecraft's MCP server in pure validator mode against WorkOS AuthKit, with richer role data from organization memberships and a smaller surface area to maintain.
date: 2026-05-30
author: Jaco Botha
authorRole: Founder, DevOptix
tags:
  - mcp
  - workos
  - authentication
  - routecraft
  - typescript
image: /images/blog/securing-mcp-with-workos/hero.png
imageAlt: "Side-by-side architecture diagram of the Clerk OAuth proxy flow and the WorkOS AuthKit validator-mode flow"
layout: blog-post
---

If you have Googled "WorkOS AuthKit MCP server" or "validator-mode OAuth MCP", you have probably found two camps: people running their own OAuth proxy in front of MCP, and people using WorkOS AuthKit's hosted endpoints directly. The second is cleaner. Less of your code in the auth path, richer role data, stateless verification. The catch: getting there from a working Clerk proxy setup is a focused refactor, not a swap.

This post is that refactor, in about fifty lines of TypeScript using [Routecraft](/docs/introduction). It assumes you already have an MCP server (the [Clerk post](/blog/securing-mcp-with-clerk) builds the starting point) and walks through swapping the auth out. Same capability code, completely different auth model.

If you are landing here cold and want the building-an-MCP-server-from-scratch story, the [first post in the series](/blog/your-first-mcp-server-in-typescript) is your starting point.

## Why migrate

The Clerk integration in part one works. So why change it?

Three reasons we hit in production on the DevOptix Eywa MCP server:

1. **The OAuth proxy is a stateful detour.** Routecraft sits between the MCP client and Clerk, forwarding `/authorize`, `/token`, and `/register` calls. Every new client touches that path. It is a moving piece we have to keep working, monitor, and reason about. Validator mode removes it entirely.
2. **Roles are organization-shaped.** Real users belong to organizations. WorkOS treats organizations and roles as first-class concepts, and a single API call returns both the user's profile and their roles. Clerk requires either custom JWT templates or extra metadata trips to surface the same data.
3. **Audience checks are easier when the issuer is yours.** WorkOS AuthKit issues tokens scoped to your application. We can set a tight `audience` in `jwks()` instead of accepting `*`.

The trade-off is real: WorkOS asks more of you up front. You configure the AuthKit URL, the organization model, the role taxonomy. Clerk was friendlier for the first hour. WorkOS is friendlier from week two onward.

## The shape of the change

Architecturally, three things move:

| Concern              | Before (Clerk)                              | After (WorkOS)                                   |
| -------------------- | ------------------------------------------- | ------------------------------------------------ |
| MCP OAuth endpoints  | `/authorize`, `/token`, `/register` on us   | Direct to WorkOS AuthKit                         |
| Auth wiring          | `oauth(...)` proxy + `jwks(...)` verify     | Plain `jwks(...)` verifier                       |
| Identity resolution  | Token claims only                           | Token claims plus a server-side membership lookup |
| Role source          | JWT template or public metadata             | WorkOS organization memberships API              |

The capability layer is untouched. `.authorize({ roles: ['member'] })` and `exchange.principal?.subject` keep working. The only thing that changes is where the principal comes from.

## Setting up WorkOS

If you do not have a WorkOS account, [sign up](https://dashboard.workos.com/signup). WorkOS is free in development; production starts metered.

### Create a project

In the WorkOS dashboard, create a new project. Pick a name (I will use "Notebook") and select **Standard auth + User Management** so that AuthKit is enabled.

![WorkOS dashboard, Create project screen with Standard auth + User Management selected](/images/blog/securing-mcp-with-workos/workos-create-project.png)

### Find your AuthKit values

Open **Authentication -> AuthKit** in the dashboard. Copy three values:

- **Client ID**, starting with `client_`
- **AuthKit URL**, something like `https://accounts.notebook-staging.workos.com`
- **API key**, starting with `sk_`

![WorkOS dashboard, AuthKit configuration with client ID, AuthKit URL, and API key highlighted](/images/blog/securing-mcp-with-workos/workos-authkit-keys.png)

Drop them into `.env`, replacing the Clerk variables from part one:

```bash
# Remove these
# CLERK_PUBLISHABLE_KEY=...
# CLERK_SECRET_KEY=...

# Add these
WORKOS_CLIENT_ID=client_...
WORKOS_AUTHKIT_URL=https://accounts.notebook-staging.workos.com
WORKOS_API_KEY=sk_...

MCP_HOST=localhost
MCP_ISSUER_URL=http://localhost:3001
```

### Create an organization and a role

WorkOS organizations are how you group users and attach roles. Create one organization to start (think of it as your tenant), then define one role under **User management -> Roles**. We will use `member` to match the capability gate in part one.

![WorkOS dashboard, Roles configuration with a member role defined](/images/blog/securing-mcp-with-workos/workos-roles.png)

Then add yourself as a member of the organization with the `member` role assigned.

### Enable Dynamic Client Registration

For Claude Desktop and Cursor to register themselves, AuthKit needs Dynamic Client Registration enabled. It lives under **Authentication -> AuthKit -> Advanced**. Flip the switch.

![WorkOS dashboard, AuthKit advanced settings with Dynamic Client Registration toggled on](/images/blog/securing-mcp-with-workos/workos-dcr.png)

That is the entirety of the dashboard work.

## Updating `env.ts`

Swap the Clerk environment schema for the WorkOS one:

```ts
// env.ts
import { z } from 'zod'

const schema = z.object({
  WORKOS_CLIENT_ID: z.string().startsWith('client_'),
  WORKOS_AUTHKIT_URL: z.url(),
  WORKOS_API_KEY: z.string().startsWith('sk_'),
  MCP_HOST: z.string().default('localhost'),
  MCP_ISSUER_URL: z.url().default('http://localhost:3001'),
})

export const env = schema.parse(process.env)
```

If you run the server now, it will fail fast on missing config, which is what we want.

## Replacing `craft.config.ts`

Here is where the actual migration happens. Replace the entire `craft.config.ts` from part one with this:

```ts
import { defineConfig, jwks } from '@routecraft/routecraft'

import { env } from './env'

export const craftConfig = defineConfig({
  name: 'notebook',
  mcp: {
    name: 'notebook',
    title: 'Notebook',
    version: '0.1.0',
    transport: 'http',
    host: env.MCP_HOST,
    cors: { origin: '*' },
    resource: {
      url: env.MCP_ISSUER_URL,
    },
    auth: jwks({
      jwksUrl: `https://api.workos.com/sso/jwks/${env.WORKOS_CLIENT_ID}`,
      issuer: env.WORKOS_AUTHKIT_URL,
      audience: env.MCP_ISSUER_URL,
    }),
    userinfo: async (principal) => {
      const orgId =
        typeof principal.claims?.org_id === 'string'
          ? principal.claims.org_id
          : undefined
      if (!orgId) return {}

      const res = await fetch(
        `https://api.workos.com/user_management/organization_memberships?user_id=${encodeURIComponent(
          principal.subject,
        )}&organization_id=${encodeURIComponent(orgId)}`,
        { headers: { Authorization: `Bearer ${env.WORKOS_API_KEY}` } },
      )
      if (!res.ok) {
        throw new Error(
          `WorkOS membership lookup failed: ${res.status} ${await res.text()}`,
        )
      }

      const { data } = (await res.json()) as {
        data: Array<{
          roles?: Array<{ slug?: string }>
          user?: {
            email?: string
            first_name?: string | null
            last_name?: string | null
          }
        }>
      }
      const membership = data[0]
      if (!membership) return {}

      const roles = membership.roles
        ?.map((r) => r.slug)
        .filter((slug): slug is string => Boolean(slug))
      const name = [membership.user?.first_name, membership.user?.last_name]
        .filter(Boolean)
        .join(' ')

      return {
        email: membership.user?.email,
        name: name || undefined,
        roles: roles && roles.length > 0 ? roles : undefined,
      }
    },
  },
})
```

Three things changed from the Clerk version:

- **No more `plugins: [mcpPlugin({...})]`.** Routecraft 0.5+ accepts an `mcp` key directly on the config, so the plugin wrapper is gone.
- **No `oauth(...)` proxy.** The `auth:` field is just `jwks(...)`. We are not forwarding `/authorize` or `/token` anywhere; we only verify bearer tokens.
- **A `userinfo` callback.** This is where the real magic lives. Read on.

## The `userinfo` callback

A WorkOS access token is small and audience-locked. It carries the user's `sub`, the `org_id`, and a handful of standard claims, but it does not carry roles or profile data inline.

That is on purpose. WorkOS does not want you to pull the whole organization graph into every token. Instead, the server (us) resolves identity and roles from the API when we see a token for the first time.

Routecraft's `userinfo` hook is the place for this. It receives the verified `principal` and returns extras that get merged onto the principal for the rest of the request:

```ts
userinfo: async (principal) => {
  // 1. Find the org this token was minted for.
  const orgId = principal.claims?.org_id
  if (!orgId) return {}

  // 2. Look up the user's membership in that org.
  const res = await fetch(
    `https://api.workos.com/user_management/organization_memberships?...`,
    { headers: { Authorization: `Bearer ${env.WORKOS_API_KEY}` } },
  )

  // 3. Return profile + roles. Routecraft merges them onto principal.
  return { email, name, roles }
}
```

A few things worth noting:

- **Why not OIDC userinfo?** WorkOS exposes a standard `/userinfo` endpoint, but it rejects audience-locked MCP tokens. We use the API key path instead. This is the documented and supported pattern.
- **The lookup is per-request.** In production you want a small TTL cache here. Even a 30-second in-process cache eliminates 90 percent of the traffic for chatty clients.
- **Roles are organization-scoped.** A user can be `member` in one org and `admin` in another. The `org_id` claim on the token disambiguates.

After `userinfo` runs, downstream code can read:

```ts
exchange.principal.subject  // WorkOS user_..., the same as before
exchange.principal.email    // From the membership lookup
exchange.principal.name     // From the membership lookup
exchange.principal.roles    // ['member'] or whatever you assigned
```

Which means `.authorize({ roles: ['member'] })` from part one works without changing a line of capability code.

## Connecting from Claude Desktop

The client side is simpler than with Clerk, because there is no proxy. The MCP client talks directly to WorkOS for the OAuth dance and to Routecraft for tool calls.

```json
{
  "mcpServers": {
    "notebook": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

First time Claude triggers a notebook tool, it reads the OAuth 2.0 Protected Resource metadata from our server, follows it to AuthKit, opens a browser, you sign in, and the token flows back. From that point on, every request carries an `Authorization: Bearer ey...` header that Routecraft verifies against WorkOS's JWKS.

![Claude Desktop showing the notebook MCP tools after the WorkOS AuthKit sign-in flow completes](/images/blog/securing-mcp-with-workos/claude-desktop-connected.png)

Cursor and VS Code's MCP extension behave the same way. The config is identical.

## Tightening the audience

One concrete win of switching to WorkOS: we can set a real `audience`.

In part one we passed `audience: '*'` because Clerk tokens were not minted for our MCP server specifically. WorkOS AuthKit tokens carry an `aud` claim pointing at the resource URL we registered, which means we can verify it:

```ts
auth: jwks({
  jwksUrl: `https://api.workos.com/sso/jwks/${env.WORKOS_CLIENT_ID}`,
  issuer: env.WORKOS_AUTHKIT_URL,
  audience: env.MCP_ISSUER_URL,   // exact match, not wildcard
}),
```

If somebody pastes in a token issued by your AuthKit for a different application in the same WorkOS account, it bounces. That is the correct behavior.

## What Routecraft just did for you

The fifty-line version above is short for a reason. Without a framework, the equivalent in raw Node looks roughly like:

```ts
// The equivalent in Express, abbreviated for length
import express from 'express'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const app = express()
const jwks = createRemoteJWKSet(
  new URL(`https://api.workos.com/sso/jwks/${env.WORKOS_CLIENT_ID}`),
)

// 1. The verifier middleware
async function verify(req, res, next) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return res.status(401).end()
  try {
    const { payload } = await jwtVerify(auth.slice(7), jwks, {
      issuer: env.WORKOS_AUTHKIT_URL,
      audience: env.MCP_ISSUER_URL,
    })
    req.principal = { subject: payload.sub, claims: payload }
    next()
  } catch {
    res.status(401).end()
  }
}

// 2. The userinfo hydration (with a cache you have to maintain)
const cache = new Map<string, { value: Principal; exp: number }>()
async function hydrate(req, _res, next) {
  const key = `${req.principal.subject}:${req.principal.claims.org_id}`
  const hit = cache.get(key)
  if (hit && hit.exp > Date.now()) {
    Object.assign(req.principal, hit.value)
    return next()
  }
  const res = await fetch(
    `https://api.workos.com/user_management/organization_memberships?...`,
    { headers: { Authorization: `Bearer ${env.WORKOS_API_KEY}` } },
  )
  // ...parse, extract roles, attach to principal, set cache TTL, handle errors
  next()
}

// 3. The MCP JSON-RPC handler, the input validation, the per-tool
//    authorization gate, and the discovery document at
//    /.well-known/oauth-protected-resource ...
```

That is roughly 100 lines and one cache-correctness problem before you have written your first tool. The Routecraft version is the `mcp:` config above. The cache, the discovery endpoint, the JSON-RPC framing, the authorize gate, and the input validation are all handled by the framework. You write the `userinfo` callback and your tools.

## Side-by-side: what got smaller

The Clerk version of `craft.config.ts` was around 60 lines once you counted the OAuth proxy, the Clerk Base derivation, and the Dynamic Client Registration lookup function. The WorkOS version above is around 50 lines, and a third of those are TypeScript types for the membership response.

More importantly, the WorkOS version has fewer moving parts at runtime:

- No outbound HTTP to Clerk's OAuth endpoints on every `/authorize` call.
- No `client(clientId)` lookup function. Dynamic Client Registration is handled entirely by WorkOS.
- No string-munging on a publishable key to figure out the issuer URL.

The thing that got bigger is `userinfo`, but it earns its keep: it hydrates email, name, and roles in one place, so capabilities can rely on `principal.email` and `principal.roles` without any further plumbing.

## What you give up

I want to be honest about the trade-offs.

- **First-time setup is longer.** Clerk lets you sign up and grab keys in two minutes. WorkOS asks you to think about organizations, AuthKit URLs, and roles up front. For a side project, Clerk's onboarding is genuinely nicer.
- **You write the membership lookup.** Routecraft does not ship a WorkOS adapter; you write the fetch. That is intentional (we do not want to depend on every auth provider's SDK), but it is code you have to maintain.
- **Pricing is different.** Clerk is friendly for low-volume hobby projects. WorkOS's pricing assumes a B2B SaaS shape. Read the pricing page before committing.

If you are building a multi-tenant B2B product, the WorkOS shape will probably feel right. If you are building a personal tool that talks to your inbox, Clerk is probably still the easier choice.

## Production checklist

The same checklist from part one mostly applies, with two additions:

- **Cache `userinfo`.** Even a 30-second cache makes a huge difference. Watch your `api.workos.com` traffic in the dashboard.
- **Watch for `org_id`-less tokens.** Personal access tokens, service tokens, or tokens minted before a user joined an org will not have `org_id`. Decide whether you want to deny them, let them through with empty roles, or fall back to a default org.
- **Tighten CORS.** `cors: { origin: '*' }` is fine for development; in production, list your actual client origins.
- **Rotate the API key.** WorkOS API keys are powerful. Use a key with the minimum scopes (read on `user_management:organization_memberships:*`) and rotate on a schedule.

## What it looks like in production

This is roughly the wiring shipped on the DevOptix Eywa MCP server. The `userinfo` callback there does the same WorkOS membership lookup but caches results in a small LRU keyed by `${userId}:${orgId}` for thirty seconds. We pull around 300 MCP requests per day from a handful of agents, and the cache absorbs all but a few hundred WorkOS API calls. That is the part one architecture turned inside out: Routecraft no longer mediates auth; it just verifies tokens, looks up roles when it sees a new user, and gets out of the way.

## Wrapping up

Two posts in, the takeaway is that Routecraft does not have an opinion about your auth provider. It exposes the primitives, `jwks()` and `oauth()` and `userinfo` and `.authorize()`, and lets you wire them however your stack wants. Clerk and WorkOS are two extremes: a friendly proxied flow on one end, a stateless validator on the other. Same capabilities, different operational model.

If you are picking one for a new project, my recommendation is:

- Solo or small team, internal tools: start with Clerk. You can always swap later.
- B2B SaaS, multi-tenant, role-driven: start with WorkOS. The org model will pay for itself.

The Routecraft docs cover both in [`@routecraft/ai`'s MCP guide](/docs/advanced/expose-as-mcp). The full Eywa source is internal, but the patterns here mirror what we run.

## Try it without leaving your browser

Open the [Routecraft playground in GitHub Codespaces](https://codespaces.new/routecraftjs/craft-playground). Drop a `.env` file with your WorkOS values in and `bun run craft run` is one command away.

Or scaffold a project locally:

```bash
bunx create-routecraft my-mcp-server
```

Full docs at [routecraft.dev/docs](/docs/introduction). Questions and corrections welcome on [GitHub](https://github.com/routecraftjs/routecraft/issues).
