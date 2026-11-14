---
"@routecraft/routecraft": minor
---

Credentials stop reaching three places they had no business in, and the built-in JWT verifier says why it refused.

**Breaking: an API key the HTTP mount verified is not on the exchange.** With `auth: apiKey(...)` the key is left out of `routecraft.http.rawHeaders`, or out of `routecraft.http.query` and `routecraft.http.url` for `in: "query"`. It was copied into event snapshots, and into the telemetry store under `captureSnapshots`, under a header name no list could know. A route that read it returns the caller from `apiKey({ verify })` as the principal.

**Breaking: a parked exchange is stored without its credential headers.** `Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization`, `X-Api-Key` and every plugin's `secretHeaders` are left out of the record a deferral writes, at every depth, as they are left out of a snapshot. A bearer token no longer sits in the deferral store for as long as an approval takes.

**`X-Api-Key` joins the credential headers**, so snapshots and the default log redaction leave it out too.

**Default log redaction covers how headers are actually logged**: title case (`Authorization`), one level of nesting (`exchange.headers`, `req.headers`, `request.headers`), the HTTP door's `routecraft.http.rawHeaders`, and its parsed cookies. It stays by exact path; `redact` names anything else.

**`auth:rejected` carries `code` and `claim` for `jwt()` too.** The built-in verifier threw plain errors, so only `jwks()` rejections were diagnosed. It now reports a wrong issuer and a wrong audience separately, a bad signature, a disallowed algorithm, a missing `exp`, a future `nbf` and a malformed token.
