---
title: httpPlugin
---

[← All plugins](/docs/reference/plugins) {% .lead %}

```ts
import { httpPlugin } from '@routecraft/routecraft'
```

Serves routes over HTTP. Backs the [`http()` source](/docs/reference/adapters/http); routes declare `.from(http({ path, method }))` and the plugin owns the listener, the port, and the global auth check. Bun runtimes bind via `Bun.serve`; Node 22+ uses a `node:http` shim. Zero runtime dependencies.

`http` is a first-class core config key, so the common path is `defineConfig({ http: {...} })` rather than `plugins: [httpPlugin(...)]`. The factory is exported for programmatic composition.

```ts
import { defineConfig, jwt } from '@routecraft/routecraft'

export const craftConfig = defineConfig({
  http: {
    port: 8080,
    host: '0.0.0.0',
    auth: jwt({ secret: process.env.JWT_SECRET!, issuer: '...', audience: '...' }),
  },
})
```

## Options

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `port` | `number` | -- | Yes | Port to bind. Use `0` to let the OS choose. |
| `host` | `string` | `127.0.0.1` | No | Host to bind. Use `0.0.0.0` to expose externally. |
| `auth` | `ValidatorAuthOptions \| ApiKeyAuthOptions` | -- | No | Global auth strategy: `jwt(...)` / `jwks(...)` (bearer) or `apiKey({...})`. No value means every route is public. |
| `maxBodySize` | `number` | `10485760` (10 MB) | No | Maximum request body in bytes. Larger requests get `413`. |
| `events` | `{ perRequest?: boolean }` | `{ perRequest: true }` | No | Toggle the `plugin:http:request:completed` event. |
| `openapi` | `{ expose?: "public" \| "authenticated" \| "off" }` | `{ expose: "public" }` | No | Controls how `GET /openapi.json` is served. `"public"` matches the convention of public API providers (Stripe, GitHub, Twilio). `"authenticated"` gates the document behind the global auth middleware. `"off"` returns 404. |

Per-route authorization uses the existing [`.authorize({ roles, scopes })`](/docs/reference/operations/authorize) builder; a route opts out of the global check with `http({ public: true })`. Built-in endpoints `/health`, `/ready`, and `/openapi.json` are served unless a user route claims the same path.

## Lifecycle

- `apply(ctx)` validates options, publishes the route registry on the context store, starts the listener, emits `plugin:http:server:listening { port, host }`.
- On context stop, the plugin closes the listener and emits `plugin:http:server:closed`.
- A bind failure (`EADDRINUSE` / `EADDRNOTAVAIL`) surfaces as [`RC5019`](/docs/reference/errors#rc5019). The plugin resets its store flags so a retry on the same context starts clean.

## Events

See [HTTP plugin events](/docs/reference/events#http-plugin-events) for the full list. The plugin also re-uses the framework's `auth:success` / `auth:rejected` events with `source: "http"`.

## Related

- [`http()` adapter](/docs/reference/adapters/http) -- both source and destination overloads.
- [Configuration](/docs/reference/configuration#http) -- the `http` first-class config key.
- [`.authorize()`](/docs/reference/operations/authorize) -- per-route role/scope/predicate checks.
