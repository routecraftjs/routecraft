---
title: http
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
http<T, R>(options: HttpOptions<T>): Destination<T, HttpResult<R>>
```

Make HTTP requests. Returns a `Destination` adapter that works with both `.to()` and `.enrich()`.

**Current support:** Routecraft currently exports `http()` only as an outbound/client adapter for making HTTP requests.

**Planned inbound support:** Routecraft does **not** yet ship an inbound HTTP source/server adapter. The planned design is shown in [Planned inbound/server HTTP support](#planned-inboundserver-http-support) below and may change before implementation.

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

`.to(http(...))` always invokes the `http()` adapter. When the adapter returns an `HttpResult`, `.to()` replaces the exchange body with that result. The first example below is a fire-and-forget pattern in intent only (the code does not read the response), but at runtime the body is still replaced by the `HttpResult`. To merge or preserve the original exchange body, use `.enrich()` with an aggregator instead of `.to(http(...))`.

```ts
// Fire-and-forget intent (code does not read the response); body is still replaced by HttpResult at runtime
.to(http({
  method: 'POST',
  url: 'https://api.example.com/webhook',
  body: (exchange) => exchange.body
}))

// http() returns HttpResult; .to() replaces exchange body with it
.to(http({ 
  method: 'GET',
  url: 'https://api.example.com/transform' 
}))
// Body is now the HttpResult (status, headers, body). Use .enrich() with an aggregator to merge or preserve the original body.

// With query parameters
.enrich(http({
  url: 'https://api.example.com/search',
  query: (exchange) => ({ q: exchange.body.searchTerm, limit: 10 })
}))
```

Options:

| Field | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `method` | `HttpMethod` | `'GET'` | No | HTTP method to use |
| `url` | `string \| (exchange) => string` | -- | Yes | Target URL (string or derived from exchange) |
| `headers` | `Record<string,string> \| (exchange) => Record<string,string>` | `{}` | No | Request headers |
| `query` | `Record<string,string|number|boolean> \| (exchange) => Query` | `{}` | No | Query parameters appended to URL |
| `body` | `unknown \| (exchange) => unknown` | -- | No | Request body (JSON serialized when not string/binary) |
| `throwOnHttpError` | `boolean` | `true` | No | Throw when response is non-2xx |
| `timeoutMs` | `number` | -- | No | Request timeout in milliseconds |

**Returns:** `HttpResult` object with `status`, `headers`, `body`, and `url`

#### Planned inbound/server HTTP support {% badge color="purple" %}planned{% /badge %}

Tentative source signature: `http({ path, method, ...options })`.

```ts
// Simple webhook endpoint
.id('webhook-receiver')
.from(http({ path: '/webhook', method: 'POST' }))

// Multiple methods on same path
.id('data-api')
.from(http({ path: '/api/data', method: ['GET', 'POST', 'PUT'] }))
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `path` | `string` | `'/'` | No | URL path to mount |
| `method` | `HttpMethod \| HttpMethod[]` | `'POST'` | No | Accepted HTTP methods |

Exchange body: `{ method, url, headers, body, query, params }`.
The final exchange becomes the HTTP response; no explicit `.to()` step is required.

Response behavior:

- The final exchange is returned to the HTTP client. If the final body is an object with optional fields `{ status?: number, headers?: Record<string,string>, body?: unknown }`, those fields are used to build the response.
- If `status` or `headers` are not provided, Routecraft returns the body with `200` status and no additional headers.
- For serialization and setting `Content-Type`, use a formatting step in your capability (e.g., a `.transform(...)` that sets appropriate headers).
