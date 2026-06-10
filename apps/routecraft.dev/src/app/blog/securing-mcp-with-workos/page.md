---
title: Building an authenticated MCP server with Routecraft and WorkOS AuthKit
description: The validator-mode companion to the Clerk walkthrough. WorkOS AuthKit hosts the whole OAuth 2.1 flow, including Dynamic Client Registration, so Routecraft drops the proxy and runs as a pure token validator. Fewer moving parts, one sharp edge around userinfo.
date: 2026-06-10
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.6.0+'
draft: false
tags:
  - mcp
  - workos
  - authentication
  - routecraft
  - typescript
layout: blog-post
---

This is the second post in a series on putting real authentication in front of an MCP server. In [the Clerk walkthrough](/blog/securing-mcp-with-clerk) we wired Routecraft up as a thin OAuth proxy: Routecraft exposed `/authorize`, `/token`, and `/register` endpoints and forwarded them to Clerk, because the MCP client needed somewhere to register itself dynamically.

WorkOS AuthKit changes the shape of the integration. AuthKit is a full OAuth 2.1 authorization server with Dynamic Client Registration built in, which means MCP clients like Claude Desktop can register with WorkOS **directly**. Routecraft does not need to proxy anything. Its whole job shrinks to two things: tell clients where the authorization server is, and verify the tokens that come back.

In Routecraft terms that is called **validator mode**, and it is the simplest authenticated MCP setup the framework supports: one `jwks()` call instead of an `oauth()` block. The [securing capabilities guide](/docs/advanced/securing-capabilities) covers the vendor-neutral theory; this post is the WorkOS-specific walkthrough.

We will reuse the same notebook server from the previous posts: `notes_list` and `notes_create`, with notes scoped per user. If you have not built it, [your first MCP server in TypeScript](/blog/your-first-mcp-server-in-typescript) gets you there in ten minutes, and the [Clerk post](/blog/securing-mcp-with-clerk#a-capability-without-auth) shows the unauthenticated starting point we are securing here.

## Proxy mode vs validator mode, in one minute

The MCP spec leans on OAuth 2.1: the client fetches the server's protected-resource metadata, learns where the authorization server lives, sends the user there to sign in, and attaches the resulting bearer token to every JSON-RPC call.

The fork in the road is Dynamic Client Registration. An MCP client nobody has pre-registered needs to register itself with the authorization server on first contact.

- **Clerk** exposes DCR through its OAuth applications feature, but the integration wants a proxy in front of it: Routecraft mounted the OAuth endpoints, forwarded to Clerk, and looked registered clients up through Clerk's REST API. That was the `oauth({ endpoints, verify, client })` block.
- **WorkOS AuthKit** speaks DCR natively at its own domain. The client registers with WorkOS, signs the user in at WorkOS, and gets its token from WorkOS. Routecraft never sits in that flow. It advertises the AuthKit domain in its RFC 9728 metadata and validates the JWT signature on every request. That is `auth: jwks({ ... })`, and nothing else.

Fewer endpoints, fewer secrets in the hot path, and no per-request client lookups. The trade-off comes later, in how you resolve user identity and roles, where WorkOS has one genuinely surprising behaviour. We will hit it head on.

## Setting up WorkOS

If you do not have a WorkOS account, [sign up](https://dashboard.workos.com/signup). The free tier covers far more users than a side project needs.

### Activate AuthKit

In the WorkOS dashboard, activate **AuthKit** for your environment and pick your sign-in methods (email plus Google is a sensible default). AuthKit gives you a hosted sign-in page on a dedicated domain.

While you are there, note your **AuthKit domain**. It looks like `https://your-app-12345.authkit.app` until you configure a custom domain. This single URL is the issuer, the discovery host, and the registration endpoint all in one; it is most of the configuration.

### Enable Dynamic Client Registration

DCR is what lets Claude Desktop register itself with WorkOS the first time it connects, with no manual client setup. In the dashboard, open your application's OAuth configuration and enable **Dynamic Client Registration**.

![WorkOS dashboard, the Dynamic Client Registration toggle in the application configuration](/images/blog/securing-mcp-with-workos/workos-dcr-toggle.png)

### Grab your API key

From **API keys**, copy the secret key (`sk_...`). The OAuth flow itself never uses it; we need it later, server-side only, to resolve roles through the WorkOS API.

Drop everything into `.env`:

```bash
WORKOS_API_KEY=sk_test_...
AUTHKIT_DOMAIN=https://your-app-12345.authkit.app
MCP_HOST=localhost
MCP_ISSUER_URL=http://localhost:3001
```

And the typed `env.ts` so missing config fails at boot, not mid-flow:

```ts
// env.ts
import { z } from 'zod'

const schema = z.object({
  WORKOS_API_KEY: z.string().startsWith('sk_'),
  AUTHKIT_DOMAIN: z.url(),
  MCP_HOST: z.string().default('localhost'),
  MCP_ISSUER_URL: z.url().default('http://localhost:3001'),
})

export const env = schema.parse(process.env)
```

## The whole auth config

Here is `craft.config.ts`, complete. Compare it with the Clerk version and you can see the proxy disappear:

```ts
// craft.config.ts
import { jwks, mcpPlugin } from '@routecraft/ai'
import { defineConfig } from '@routecraft/routecraft'

import { env } from './env'

export const craftConfig = defineConfig({
  plugins: [
    mcpPlugin({
      name: 'notebook',
      title: 'Notebook',
      version: '0.1.0',
      transport: 'http',
      host: env.MCP_HOST,
      resource: { url: `${env.MCP_ISSUER_URL}/mcp` },
      auth: jwks({
        jwksUrl: `${env.AUTHKIT_DOMAIN}/oauth2/jwks`,
        issuer: env.AUTHKIT_DOMAIN,
        audience: '*',
      }),
    }),
  ],
})
```

What each piece does:

- **`resource: { url }`** identifies this server as an OAuth 2.0 protected resource (RFC 9728). It becomes the `resource` field in the metadata document that MCP clients fetch first.
- **`jwks()`** turns on validator mode. Routecraft fetches WorkOS's signing keys from the JWKS endpoint (with rotation handled for you), then verifies the signature, issuer, and expiry of every bearer token that arrives at `/mcp`.
- **The issuer doubles as discovery.** In validator mode, Routecraft derives the `authorization_servers` entry in its RFC 9728 metadata from the validator's `issuer`. Clients read it, walk to `${AUTHKIT_DOMAIN}/.well-known/oauth-authorization-server`, and from that point the entire flow (registration, sign-in, tokens) is between the client and WorkOS.
- **`audience: '*'`** explicitly skips audience validation, which is the honest starting point when tokens carry no `aud` claim. Decode one of your AuthKit access tokens and check: if your setup mints an `aud` (for example when clients request your resource URL via RFC 8707 resource indicators), tighten this to that exact value. Cross-audience replay protection is worth having; claiming it while the IdP does not emit `aud` is not.

Start the server and confirm the discovery document:

```bash
curl http://localhost:3001/.well-known/oauth-protected-resource
```

You should see your resource URL and an `authorization_servers` array containing your AuthKit domain. No proxy endpoints, because there are none.

## The userinfo trap

Now the sharp edge, and the reason this post exists beyond swapping URLs.

The notebook capabilities scope notes by `exchange.principal.subject`, which is the WorkOS user ID from the token's `sub` claim. That works out of the box. But the JWT alone does not carry everything you want: depending on your setup, email, name, and roles may not be in the claims at all, and `.authorize({ roles: [...] })` has nothing to check against.

The OIDC-textbook answer is the userinfo endpoint: take the bearer token, call the IdP's `/oauth2/userinfo`, get the profile back. Routecraft even automates that pattern with `userinfo: true`.

With audience-locked MCP tokens, that answer fails against WorkOS: the userinfo endpoint rejects the access token with a **401**, because the token was minted for your MCP resource, not for WorkOS's own API. You will stare at a valid, signature-checked token being refused by its own issuer. This cost me an afternoon in production, so it gets its own heading.

The correct approach is to skip userinfo entirely and resolve the user server-side through the WorkOS **organization memberships API**, authenticated with your API key rather than the user's token. The token's claims carry the `org_id`; the membership record carries the role. Routecraft's `userinfo` option accepts a custom function for exactly this kind of non-OIDC backend:

```ts
// craft.config.ts (add to mcpPlugin options)
userinfo: async (principal) => {
  const url = new URL(
    'https://api.workos.com/user_management/organization_memberships',
  )
  url.searchParams.set('user_id', principal.subject)
  const orgId = principal.claims?.['org_id']
  if (typeof orgId === 'string') {
    url.searchParams.set('organization_id', orgId)
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.WORKOS_API_KEY}` },
  })
  if (!res.ok) {
    throw new Error(`WorkOS membership lookup failed: ${res.status}`)
  }

  const { data } = (await res.json()) as {
    data: Array<{ role: { slug: string } }>
  }
  return { roles: data.map((m) => m.role.slug) }
},
```

Three things Routecraft does around this callback that you would otherwise hand-roll:

- **It runs after verification, never instead of it.** The principal you receive has already passed signature, issuer, and expiry checks. Protected fields (`subject`, `issuer`, `audience`, `expiresAt`) cannot be overwritten by enrichment; your `roles` are merged on top.
- **It is cached per token.** The enrichment result is cached against a hash of the token and evicted when the token expires, and concurrent requests for the same token share one in-flight lookup. Your WorkOS API quota sees one call per token lifetime, not one per tool call.
- **It fails closed.** If the lookup throws, the request is rejected. An agent never executes a tool as a half-resolved user.

## Authorizing per tool

With roles on the principal, the capability-side code is identical to the Clerk version, which is the point of the whole design: the IdP is configuration, the capability is portable.

```ts
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

`.authorize()` sits before `.from()` because it stages onto the route and runs at route entry, before any pipeline step. `member` is the default role slug WorkOS assigns to organization members; define stricter roles in the dashboard and they arrive as their slugs.

## Connecting from Claude Desktop

Same as the Clerk post:

```json
{
  "mcpServers": {
    "notebook": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

Restart Claude Desktop, trigger a notebook tool, and the browser opens on your AuthKit sign-in page. Behind that first connection, Claude fetched your protected-resource metadata, registered itself with WorkOS via DCR, and exchanged the sign-in for a token, with your server doing nothing but serving one JSON document. The end state looks the same as in [the Clerk post](/blog/securing-mcp-with-clerk#connecting-from-claude-desktop): the notebook tools listed, the token riding along on every call.

## Clerk or WorkOS?

Having now built the same server against both, an honest comparison:

| | Clerk (proxy mode) | WorkOS AuthKit (validator mode) |
|---|---|---|
| Routecraft auth config | `oauth({ endpoints, verify, client })` | `jwks({ jwksUrl, issuer, audience })` |
| Dynamic Client Registration | Proxied through your server, plus a client lookup callback | Native at the AuthKit domain |
| OAuth endpoints on your server | `/authorize`, `/token`, `/register` | None |
| Secrets in the request path | Clerk secret key (client lookups) | None (API key only in `userinfo`) |
| Identity enrichment | JWT template claims or userinfo | Organization memberships API (userinfo endpoint rejects MCP tokens) |
| Best fit | Already on Clerk; want one dashboard for app and MCP auth | B2B and multi-tenant apps; want the thinnest possible MCP auth surface |

Both are production-fit. If you are starting fresh and the MCP server is the product, the validator-mode setup is fewer moving parts to operate and to audit. If your application already lives on one of these providers, stay there; the capability code does not care.

## Production checklist

- **Set `MCP_ISSUER_URL` to your public HTTPS URL** and keep `resource.url` aligned with what clients actually connect to. RFC 9728 metadata with the wrong resource URL fails in ways that look like client bugs.
- **Check your tokens for an `aud` claim and tighten `audience`** the moment one is there. `'*'` is an explicit opt-out, not a default to ship and forget.
- **Use a production WorkOS environment.** Staging environments and `sk_test_` keys are for development.
- **Lock CORS down** once you know your callers. The MCP plugin's default is loopback-only, which is already production-safe; widen it deliberately, not preemptively.
- **Watch the membership lookup's failure mode.** It fails closed, which is correct, and it also means a WorkOS API outage degrades your server to 401s for new tokens. Alert on `RC5021` in your logs so you can tell that story apart from a real auth attack.
- **Log rejections with reasons.** Routecraft's structured logs carry the principal on success and the rejection reason on failure; ship them somewhere queryable before you need them.

## What's next

Between this post and [the Clerk walkthrough](/blog/securing-mcp-with-clerk) you have the two shapes that cover practically every IdP: proxy mode when the provider needs help with Dynamic Client Registration, validator mode when it speaks the full flow itself. The vendor-neutral concepts behind both live in [securing capabilities](/docs/advanced/securing-capabilities).

The fastest way to try this without installing anything is the [Routecraft playground in GitHub Codespaces](https://codespaces.new/routecraftjs/craft-playground). Or scaffold locally:

```bash
bunx create-routecraft my-mcp-server
```

Full docs at [routecraft.dev/docs](/docs/introduction).
