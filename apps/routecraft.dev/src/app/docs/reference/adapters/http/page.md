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

// Public endpoint (bypasses the global JWT check)
export const health = craft()
  .id('health-extra')
  .from(http({ path: '/health-extra', method: 'GET', public: true }))
  .transform(() => ({ status: 'ok' }))
  .to(noop())
```

**Source options** (`http(options)` with `.from(...)`):

| Field | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `path` | `string` | -- | Yes | Path pattern with `:param` segments (e.g. `/orders/:id`). |
| `method` | `HttpMethod` | `GET` | No | HTTP method this route handles. |
| `public` | `boolean` | `false` | No | Skip the global `auth` check for this route (and skip principal attachment). Combining `public: true` with `.authorize(...)` always rejects, since no principal is present. |

### Request metadata on the exchange

- `routecraft.http.method` -- request method (typed `HttpMethod`).
- `routecraft.http.path` -- matched pattern (e.g. `/orders/:id`).
- `routecraft.http.url` -- raw request URL (path + query).
- `routecraft.http.params` -- `Record<string, string>` of URL-decoded path params.
- `routecraft.http.query` -- `Record<string, string>` of query params.
- `routecraft.http.headers` -- `Record<string, string>` of request headers, lower-cased.
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
- `GET /ready` -> `200` `{ status: "ready", routes }`. K8s readiness target.
- `GET /openapi.json` -> OpenAPI 3.1 document built from the route registry. Paths, methods, summaries, descriptions, and path params populate in v1; request/response body schemas are stubs until the Standard-Schema-to-JSON-Schema follow-up lands.

### Auth

`http: { auth }` accepts:

- `jwt({...})` / `jwks({...})` -- bearer token with validator (same shape MCP uses).
- `apiKey({ keys: [...] })` -- static allowlist. Reads from a header (default `x-api-key`) or, with `in: "query"`, a query parameter (default `api_key`).
- `apiKey({ verify: (key) => Principal | null })` -- custom verifier that resolves to a per-user principal.

The middleware runs once per incoming request. Rejection returns `401` directly (no route runs). Admission attaches the resolved `Principal` to the exchange (`routecraft.auth.principal`), and per-route guards via the existing `.authorize({ roles, scopes, predicate })` builder take it from there. Per-route opt-out via `http({ public: true })` skips both the auth middleware and principal attachment.

API-key name matching follows each location's convention: header names are case-insensitive (per HTTP), so the `name` is matched case-insensitively; query parameter names are case-sensitive (per the URL spec), so the `name` must match exactly. Note the default name differs by location: `x-api-key` for headers, `api_key` for query.

OAuth 2.1 is reserved in the auth union for a future release.

### Route matching and information disclosure

The dispatcher resolves path/method before running auth, so unmatched paths return `404` and matched paths with a different method return `405` (with an `Allow` header) even to unauthenticated callers. This is standard HTTP behaviour (it mirrors Express/Fastify/Hono and avoids forcing an auth check on nonexistent routes), but it does let an unauthenticated client enumerate which paths and methods exist. It is intentional; if route concealment matters for a specific deployment, terminate it at a gateway in front of the service.

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
