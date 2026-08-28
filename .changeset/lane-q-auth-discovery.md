---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
"@routecraft/cli": minor
---

Http surfaces become discoverable protected resources, and the CLI reads the challenge (#669).

Routecraft verifies; issuers issue. This release makes a refused caller able to find out who issues, on every http surface rather than only MCP.

## Server

- The RFC 9728 protected-resource metadata builder and the CORS policy engine move from `@routecraft/ai` into core (`buildProtectedResourceMetadata`, `HttpCorsOptions`, exported from the package root). MCP consumes the shared implementation with unchanged behaviour on its own claimed paths; `McpCorsOptions` and `McpCorsOriginResolver` remain as aliases.
- Every http server serves `/.well-known/oauth-protected-resource`, with RFC 9728 path-suffixed documents mirroring any path no mount claims exactly. Documents are sourced from the owning mount's effective validator (issuer from `jwt()` / `jwks()`) and declared scopes; the ops mount declares its scope-gated tier values as `scopes_supported`. A bare `{ validator }` with no issuer yields an honest minimal document.
- Every bearer 401 (shared middleware, the synthesized missing-credential response on http and ops) carries a `resource_metadata` hint in its `WWW-Authenticate` challenge; the ops `insufficient_scope` 403 carries it alongside the `scope` it already named.

## CLI

- `craft exec` and `craft ops` parse `WWW-Authenticate` on a refusal, follow the `resource_metadata` hint (best effort, 5s timeout), and extend the refusal with which scope is required, who issues acceptable tokens, and how to supply a credential (`--token`, `CRAFT_TOKEN`, settings file).
- `.routecraft/settings.yml` is accepted beside `settings.yaml`, resolved independently per location; a location carrying both spellings refuses with both paths named.

## Docs

The credential ladder as recipes on securing-capabilities and the ops reference: no auth, a static key compared with `timingSafeStringEqual`, a self-signed JWT via `jwt({ secret })`, and a real IdP via `jwks()`. The static-key recipe is compiled and run verbatim by the test suite.
