---
title: http
---

[← All adapters](/docs/reference/adapters) {% .lead %}

`http()` is overloaded by option shape:

- `http({ path, method?, public? })` returns a **Source**. Use with `.from(...)` to expose a route over HTTP. Requires `defineConfig({ http: {...} })` for the server config (port, host, global auth). Bun runtimes bind via `Bun.serve` natively; Node 22+ uses a thin `node:http` shim. Zero runtime dependencies.
- `http({ url, ... })` returns a **Destination**. Use with `.to()` / `.enrich()` / `.tap()` to call a remote HTTP endpoint.

The discriminator is the presence of `path` (source) vs `url` (destination).

## HTTP source (inbound)

```ts
http(options: HttpSourceOptions): Source<HttpRequestBody>
```

The server, port, host, and global auth live on [`defineConfig({ http })`](/docs/reference/configuration#http), not on the source. Routes only declare which request they want.

```ts
// craft.config.ts
import { defineConfig, jwt } from '@routecraft/routecraft'

export const craftConfig = defineConfig({
  http: {
    port: 8080,
    host: '0.0.0.0',
    auth: jwt({
      secret: process.env.JWT_SECRET!,
      issuer: process.env.JWT_ISSUER!,
      audience: process.env.JWT_AUDIENCE!,
    }),
  },
})
```

```ts
// routes/orders.ts
import { craft, http, noop, DefaultExchange } from '@routecraft/routecraft'

// GET /orders/:id
export const getOrder = craft()
  .id('get-order')
  .description('Fetch an order by id')
  .from(http({ path: '/orders/:id', method: 'GET' }))
  .process(async (ex) => {
    const { id } = ex.headers['routecraft.http.params']!
    return DefaultExchange.rewrap(ex, { body: await loadOrder(id) })
  })
  .to(noop())

// POST /orders
export const createOrder = craft()
  .id('create-order')
  .description('Create an order')
  .input({ body: createOrderSchema })
  .authorize({ scopes: ['orders.write'] })
  .from(http({ path: '/orders', method: 'POST' }))
  .transform((body) => saveOrder(body))
  .to(noop())

// DELETE /orders/:id  -> 204 when body is undefined
export const deleteOrder = craft()
  .id('delete-order')
  .authorize({ roles: ['admin'] })
  .from(http({ path: '/orders/:id', method: 'DELETE' }))
  .process(async (ex) => {
    await deleteOrderById(ex.headers['routecraft.http.params']!.id)
    return DefaultExchange.rewrap(ex, { body: undefined })
  })
  .to(noop())

// Public endpoint, bypasses the global JWT check entirely (no auth events).
export const health = craft()
  .id('health-extra')
  .from(http({ path: '/health-extra', method: 'GET', auth: 'skip' }))
  .transform(() => ({ status: 'ok' }))
  .to(noop())

// Public endpoint that still personalises when a valid token is presented.
export const home = craft()
  .id('home')
  .from(http({ path: '/', method: 'GET', auth: 'optional' }))
  .process(async (ex) =>
    DefaultExchange.rewrap(ex, { body: `hello, ${ex.principal?.subject ?? 'guest'}` }),
  )
  .to(noop())
```

**Source options** (`http(options)` with `.from(...)`):

| Field | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `path` | `string` | -- | Yes | Path pattern with `:param` segments (e.g. `/orders/:id`). |
| `method` | `HttpMethod` | `GET` | No | HTTP method this route handles. |
| `auth` | `"required" \| "optional" \| "skip"` | `"required"` | No | Per-route handling of the plugin's global `auth` middleware. See [Auth modes](#auth-modes) below. No effect when no global `auth` is configured. |

### Request metadata on the exchange

- `routecraft.http.method` -- request method (typed `HttpMethod`).
- `routecraft.http.path` -- matched pattern (e.g. `/orders/:id`).
- `routecraft.http.url` -- raw request URL (path + query).
- `routecraft.http.params` -- `Record<string, string>` of URL-decoded path params.
- `routecraft.http.query` -- `Record<string, string>` of query params.
- `routecraft.http.rawHeaders` -- `Record<string, string>` of the raw request headers, lower-cased. This is the open-ended pass-through wire-header remainder (the parsed envelope above is promoted to its own keys); it mirrors `routecraft.mail.rawHeaders`.
- `routecraft.auth.principal` -- the authenticated `Principal` (when auth is configured). `ex.principal` is sugar over this header.

### Request body parsing (driven by `Content-Type`)

- `application/json` -> parsed object.
- `text/*` -> string.
- `application/x-www-form-urlencoded` -> object built from `URLSearchParams`.
- `multipart/form-data` -> Web `FormData` (with `File` entries for uploads).
- anything else -> `Uint8Array`.

Cap controlled by `http: { maxBodySize?: number }` (default 10 MB). Larger requests return `413 Payload Too Large`.

### Response convention (deterministic, override via exchange headers)

- `undefined` / `null` -> `204 No Content`.
- string -> `200`, `Content-Type: text/plain; charset=utf-8`.
- `Uint8Array` / `ArrayBuffer` -> `200`, `Content-Type: application/octet-stream`.
- object / array -> `200`, `Content-Type: application/json; charset=utf-8`.
- `ReadableStream` / `AsyncIterable` -> rejected with `RC5018` (SSE deferred to a follow-up).

Override via the exchange before the response is built:

- `routecraft.http.response.status` -> numeric status (e.g. `201`).
- `routecraft.http.response.contentType` -> explicit content-type.
- `routecraft.http.response.headers` -> extra response headers.

### Built-in endpoints

Registered alongside user routes; user routes with the same path always win.

- `GET /health` -> `200` `{ status: "ok" }`. K8s liveness target.
- `GET /ready` -> `200` `{ status: "ready", routes }` for authenticated callers; `{ status: "ready" }` for anonymous callers when global `auth` is configured. K8s readiness target.
- `GET /openapi.json` -> OpenAPI 3.1 document built from the route registry. Paths, methods, summaries, descriptions, and path params populate in v1; request/response body schemas are stubs until the Standard-Schema-to-JSON-Schema follow-up lands.

#### Configuring built-ins

Every built-in takes the same `{ enabled?, requireAuth? }` shape under `http: { builtins }`. Inspired by Spring Boot Actuator's `management.endpoint.<name>.enabled` plus `show-details: when-authorized`, compressed to a single boolean for the auth gate.

```ts
defineConfig({
  http: {
    port: 8080,
    auth: jwt({ ... }),
    builtins: {
      health:  { enabled: true },                   // defaults
      ready:   { enabled: true, requireAuth: true },
      openapi: { enabled: true, requireAuth: false },
    },
  },
})
```

What `requireAuth` does, per endpoint:

| Endpoint | `requireAuth: false` | `requireAuth: true` |
| --- | --- | --- |
| `/health` | n/a (response has no detail to gate) | n/a |
| `/ready` | always `{ status: "ready", routes }` | anon: `{ status: "ready" }`; authed: `{ status: "ready", routes }`. **Always 200** so k8s probes work without a credential. |
| `/openapi.json` | doc to anyone | 401 to anon; doc to authed |

Defaults match security best practice per endpoint:

- `health`:  `enabled: true` (k8s liveness must be open).
- `ready`:   `enabled: true, requireAuth: true` (gates the `routes` count from anonymous callers; matches Spring Actuator's default).
- `openapi`: `enabled: true, requireAuth: false` (matches the Stripe / GitHub / Twilio / OpenAI convention of publishing the schema publicly).

`enabled: false` returns 404 for that path. `requireAuth` has no effect when no global `auth` is configured (collapses to `false` because there is nothing to authenticate against).

#### OpenAPI `info` block

`builtins.openapi.info` populates the OpenAPI document's `info` object. When omitted, `title` and `version` auto-detect from the nearest `package.json` (walks up from `process.cwd()`); supply either field explicitly to override.

```ts
builtins: {
  openapi: {
    info: {
      title: "Orders API",        // overrides package.json `name`
      version: "1.2.3",            // overrides package.json `version`
      description: "Customer order management.",
      contact: { name: "Platform Team", email: "platform@example.com" },
      license: { name: "MIT", url: "https://opensource.org/license/mit" },
    },
  },
},
```

Auto-detection is conservative: only `name` and `version` are pulled because both are public by nature once a package is published to npm. `description`, `contact`, and `license` stay opt-in because `package.json` often carries internal context (TODO notes, author emails, license boilerplate) you may not want leaking through a publicly served document. Set them explicitly to publish them. When no `package.json` is reachable (single-file bundled binaries, Docker scratch images), the document falls back to `Routecraft HTTP API` / `0.0.0`.

### Auth

`http: { auth }` accepts:

- `jwt({...})` / `jwks({...})` -- bearer token with validator (same shape MCP uses).
- `apiKey({ keys: [...] })` -- static allowlist. Reads from a header (default `x-api-key`) or, with `in: "query"`, a query parameter (default `api_key`).
- `apiKey({ verify: (key) => Principal | null })` -- custom verifier that resolves to a per-user principal.

The middleware runs once per incoming request. The route's `auth` option decides what happens with the result (see [Auth modes](#auth-modes) below). When admitted, the resolved `Principal` lands on the exchange (`routecraft.auth.principal`), and per-route guards via the existing `.authorize({ roles, scopes, predicate })` builder take it from there.

API-key name matching follows each location's convention: header names are case-insensitive (per HTTP), so the `name` is matched case-insensitively; query parameter names are case-sensitive (per the URL spec), so the `name` must match exactly. Note the default name differs by location: `x-api-key` for headers, `api_key` for query.

OAuth 2.1 is reserved in the auth union for a future release.

#### Auth modes

The `auth` option on `http({...})` chooses one of three modes per route. It has no effect when the plugin is configured without a global `auth` strategy.

| Mode | Credential present, valid | Credential present, invalid | Credential absent |
| --- | --- | --- | --- |
| `"required"` (default) | admit, principal attached, `auth:success` | 401, `auth:rejected` | 401 |
| `"optional"` | admit, principal attached, `auth:success` | 401, `auth:rejected` | admit, no principal, no auth event |
| `"skip"` | bypass middleware entirely; no principal, no auth event | bypass middleware entirely; no principal, no auth event | bypass middleware entirely; no principal, no auth event |

Rules of thumb:

- **`"required"`** is the secure-by-default tier. Use it for every endpoint that handles authenticated user data.
- **`"optional"`** is for public routes that personalise when the caller happens to be signed in: a homepage greeting, a docs page with a "logged in as X" header, an API endpoint that rate-limits anonymous higher than authenticated. The check stays strict when a credential _is_ presented; a malformed or forged token still returns 401 rather than being silently accepted as anonymous.
- **`"skip"`** is for truly identity-free endpoints: health probes, RSS feeds, OG image generation, redirect handlers. No middleware runs at all, so no verification cost and no `auth:*` event noise.

Combining `auth: "skip"` with `.authorize({...})` is rejected at request time: a `"skip"` route never attaches a principal, so the authorization check has nothing to evaluate. That is intentional. If you need role/scope checks, use `"required"` (or `"optional"`) plus `.authorize({...})`.

### Route matching and information disclosure

The dispatcher resolves path/method before running auth, so unmatched paths return `404` and matched paths with a different method return `405` (with an `Allow` header) even to unauthenticated callers. This is standard HTTP behaviour (Express/Fastify/Hono all do the same), and `GET /openapi.json` is served publicly by default (matching the Stripe/GitHub/Twilio convention). Both choices are intentional: protection comes from auth on each endpoint, not from hiding the surface. If a deployment genuinely needs route concealment, gate the OpenAPI spec with `builtins: { openapi: { requireAuth: true } }` (or disable it with `enabled: false`) and put the service behind a gateway that strips 404/405 differentiation.

### Events

- `plugin:http:server:listening` -> `{ port, host }` after the listener binds.
- `plugin:http:server:closed` after graceful shutdown.
- `plugin:http:request:completed` -> `{ method, path, status, durationMs, routeId?, principal? }` per request (toggle with `http: { events: { perRequest: false } }`).
- `auth:success` / `auth:rejected` -- reused from the framework's existing auth event surface (`source: "http"`).

See [HTTP plugin events](/docs/reference/events#http-plugin-events) on the events reference.

## HTTP destination (outbound)

```ts
http<T, R>(options: HttpOptions<T>): Destination<T, HttpResult<R>>
```

Make HTTP requests. Returns a `Destination` that works with `.to()` and `.enrich()`.

**With `.enrich()` (merge result into body):**

```ts
// Static GET request - result merged into body
.enrich(http({
  method: 'GET',
  url: 'https://api.example.com/users'
}))

// Dynamic URL based on exchange data
.enrich(http({
  method: 'GET',
  url: (exchange) => `https://api.example.com/users/${exchange.body.userId}`
}))

// Custom aggregator to control merge behavior
.enrich(
  http({ url: 'https://api.example.com/profile' }),
  (original, result) => ({
    ...original,
    body: { ...original.body, profileData: result.body }
  })
)
```

**With `.to()` (side-effect or body replacement):**

`.to(http(...))` always invokes the `http()` adapter. When the adapter returns an `HttpResult`, `.to()` replaces the exchange body with that result. The first example below is a fire-and-forget pattern in intent only (the code does not read the response), but at runtime the body is still replaced by the `HttpResult`. To merge or preserve the original exchange body, use `.enrich()` with an aggregator instead.

```ts
.to(http({
  method: 'POST',
  url: 'https://api.example.com/webhook',
  body: (exchange) => exchange.body
}))

.to(http({
  method: 'GET',
  url: 'https://api.example.com/transform'
}))

.enrich(http({
  url: 'https://api.example.com/search',
  query: (exchange) => ({ q: exchange.body.searchTerm, limit: 10 })
}))
```

**Destination options:**

| Field | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `method` | `HttpMethod` | `'GET'` | No | HTTP method to use |
| `url` | `string \| (exchange) => string` | -- | Yes | Target URL (string or derived from exchange) |
| `headers` | `Record<string,string> \| (exchange) => Record<string,string>` | `{}` | No | Request headers |
| `query` | `Record<string,string\|number\|boolean> \| (exchange) => Query` | `{}` | No | Query parameters appended to URL |
| `body` | `unknown \| (exchange) => unknown` | -- | No | Request body (JSON serialized when not string/binary) |
| `throwOnHttpError` | `boolean` | `true` | No | Throw when response is non-2xx |
| `timeoutMs` | `number` | -- | No | Request timeout in milliseconds |

**Returns:** `HttpResult` object with `status`, `headers`, `body`, and `url`.
