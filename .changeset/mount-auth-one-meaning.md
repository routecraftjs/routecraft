---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

Unify mount auth across http, mcp and ops, and make the listener a mount property (#628).

One vocabulary on every mount:

- `auth` unset inherits the server validator as a wall when one exists.
- `auth: <config>` is the mount's own wall, replacing the server's validator.
- `auth: false` removes the wall and keeps the inherited validator reachable, so a route's `.authorize()` still pulls identity through it. On mcp this replaces "credentials are never inspected": a valid token now attaches a principal to tool calls and an invalid one is treated as absent.

The registry resolves the rule once into per-mount facts (`HttpMountAuth` on the mount context: `configured` / `own` / `optedOut` / `walled`); `serverAuthConfigured` is removed from `WebIngress` and `HttpMountContext`.

The ops surface gains `auth`, feeding its `health.details` gate through the mount's effective validator without ever walling the probes. The gate now fails closed with no validator in scope: an explicit `when-authenticated` refuses the boot, and the unwritten default withholds details with a startup warning instead of serving them to every caller.

`server` becomes a mount property on http: each entry under `mounts` names its own listener (default `"default"`), the plugin's top-level `server` remains only as the single-mount shorthand and is refused alongside `mounts`, and the built-ins describe only routes on their own listener.

```ts
defineConfig({
  servers: { default: { port: 8080 }, internal: { port: 9090 } },
  ops:  { auth: { kind: "apiKey", name: "x-ops-key", keys: [opsKey] } },
  mcp:  { auth: jwks({ issuer }) },
  http: {
    mounts: {
      api:      { path: "/api", auth: { kind: "apiKey", keys: [apiKey] } },
      webhooks: { path: "/webhooks", auth: false },
      admin:    { path: "/admin", server: "internal" },
    },
  },
})
```
