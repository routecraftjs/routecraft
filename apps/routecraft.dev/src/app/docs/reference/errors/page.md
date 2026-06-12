---
title: Errors
---

Short, actionable error codes used across Routecraft. {% .lead %}

Core codes use the `RC` namespace. Ecosystem packages own their codes under registered namespaces: `@routecraft/ai` uses `AI` (e.g. `AI1001`). See `registerErrorCodes` for adding a namespace.

Each error includes a code, message, a brief suggestion, and underlying error. A code is its owner's namespace followed by four digits: core codes follow `RCcnnn` where `c` is category and `nnn` is the number, and ecosystem packages use their registered namespace (`AI1001`). Adapters throw them with specific message and suggestion overrides via `rcError(rc, cause, { message, suggestion })`. When the framework logs an error, structured meta (`rc`, `message`, `suggestion`, `causeMessage`, `causeStack`) is included so you can search and alert in your log aggregator.

The `Retry` column shows whether the [`retry`](/docs/reference/operations/retry) wrapper will retry this error by default. Codes marked `No` typically represent permanent failures (bad input, configuration errors) that won't succeed on retry.

{% error-table /%}

---

## RC1001
Route definition failed validation

**Why it happens**  
The route is missing required fields, most commonly a source.

**Suggestion**  
Ensure a source is defined: start with `from(adapter)` and then add steps.

**Example**
```ts
craft().id('my-route').from(timer())
```

## RC1002
Duplicate route id

**Why it happens**  
Two or more routes share the same id.

**Suggestion**  
Ensure each route id is unique or set `routeOptions.id`.

**Example**
```ts
craft().from(timer()).id('users');
craft().from(timer()).id('orders');
```

## RC1003
Error code registration failed

**Why it happens**  
An ecosystem package called `registerErrorCodes()` with an invalid namespace, a code that does not match its namespace, or a namespace already claimed by a different package. The `RC` namespace is reserved for core.

**Suggestion**  
Namespaces must match `/^[A-Z][A-Z0-9]{1,7}$/` and every code must be the namespace followed by exactly four digits (e.g. `AI1001`). If two installed packages claim the same namespace, report the collision to both package owners; consumers cannot resolve it locally.

## RC2001
Invalid operation type

**Why it happens**  
Either a step received unsupported input (e.g. `split()` on a non-array), or `from()` was called with no sources, or with multiple sources but without a preceding `input({ body })`. Multi-ingress routes share one pipeline, so they need one shared input schema to validate and normalize every channel to the same body type.

**Suggestion**  
Use a supported operator and verify the step name. For a multi-ingress route, declare `input({ body })` before `from()`, or expose each channel as its own single-source route.

**Example**
```ts
// split requires an array
craft().from(simple(['a','b'])).split()

// multi-ingress requires a shared input schema
craft()
  .id('my-route')
  .input(MyBodySchema) // required with multiple sources
  .from(direct(), mcp())
  .to(handler)
```

## RC2002
Missing from step

**Why it happens**  
Steps were added before defining a source.

**Suggestion**  
Start the route with `from` and a valid source adapter.

**Example**
```ts
craft().from(timer()).transform(x => x)
```

## RC3001
Route failed to start

**Why it happens**  
The route's abort controller was already aborted or an adapter could not initialize.

**Suggestion**  
Ensure the route isn't aborted before `start()`. Verify adapter configuration.

**Example**
```ts
const ctx = await new ContextBuilder().routes(myRoute).build();
await ctx.start();
```

## RC3002
Context failed to start

**Why it happens**  
Invalid configuration, duplicate ids, or missing sources.

**Suggestion**  
Validate plugin exports and global configuration.

**Example**
```ts
const ctx = await new ContextBuilder().routes(validRoutes).build()
await ctx.start()
```

## RC5001
Step execution failed

**Why it happens**  
A step in the pipeline threw (process, transform, filter, tap, destination, etc.). The framework wraps plain Errors with this code and preserves the original message.

**Suggestion**  
Read the error message and suggestion in the log; check adapter documentation. Use `rcError("RC5010", cause, { message, suggestion })` for connection failures, RC5013 for rate limits, etc., so users get a specific docs page.

## RC5002
Validation failed

**Why it happens**  
Framework-enforced schema validation failed. The engine validates the route's `.input()` schema before the pipeline runs (and emits `exchange:dropped` on failure) and the route's `.output()` schema before the primary destination fires (routes to the error handler on failure). RC5002 also covers `validate()` steps, aggregators that received an empty array, and any validator that threw.

**Suggestion**  
Adjust the schema or coerce input; check data shapes. For Zod: use `z.object()`, `z.looseObject()`, or `z.strictObject()` as appropriate.

## RC5003
Adapter misconfigured

**Why it happens**  
Adapter was used in the wrong role (e.g. dynamic endpoint as source), required options are missing, or the adapter does not support this usage.

**Suggestion**  
Check required options and correct role usage (`.from()` vs `.to()`). Example: direct sources take no endpoint string (`.from(direct())` or `.from(direct(options))`); dynamic endpoints are only valid on destinations (`.to()`, `.tap()`).

## RC5004
No handler available

**Why it happens**  
A producer sent to a direct endpoint but no consumer route is subscribed, or the consumer route has stopped.

**Suggestion**  
Ensure the consumer route is running before sending. Check route startup order and that endpoint names match.

**Example**
```ts
craft().id('my-endpoint').from(direct()).to(log());
craft().id('producer').from(simple('message')).to(direct('my-endpoint'));
```

## RC5010
Connection failed

**Why it happens**  
Network unreachable, connection refused, DNS failure, or service not running.

**Suggestion**  
Check network, DNS, ports, and firewall; verify the service is running.

## RC5011
Request timeout

**Why it happens**  
The operation exceeded its deadline (e.g. ETIMEDOUT).

**Suggestion**  
Increase timeout or configure retry with backoff.

## RC5012
Authentication failed

**Why it happens**  
Two cases share this code:
- An upstream service rejected the request: invalid credentials, expired token, or a 401 response.
- A route's `.authorize()` guard ran (or `.validate(authorize(...))` mid-pipeline) and the exchange carried no authenticated principal. The source did not resolve one and no `.process()` step attached a custom one.

**Suggestion**  
- For upstream-API failures: verify API keys, tokens, audience/issuer, and credential rotation. Check that the auth header is reaching the destination.
- For in-route failures: configure `auth:` on the source (e.g. `mcp({ auth: jwt(...) })`) so the source emits a principal, or attach a custom principal in a `.process()` step before the `authorize()` validator runs. See [`.authorize()`](/docs/reference/operations/authorize).

## RC5013
Rate limited

**Why it happens**  
Service returned 429 or quota exceeded.

**Suggestion**  
Reduce request frequency or configure retry with backoff.

## RC5014
Resource not found

**Why it happens**  
The resource does not exist (e.g. 404, model ID not found, endpoint or queue name wrong).

**Suggestion**  
Check that the resource exists (model ID, endpoint, queue name).

## RC5015
Permission denied

**Why it happens**  
Two cases share this code:
- An upstream service denied the operation (e.g. 403 from access control or IAM).
- A route's `.authorize()` guard ran (or `.validate(authorize(...))` mid-pipeline), the exchange had a principal, but the principal was missing a required role or scope, or a custom predicate returned `false`.

**Suggestion**  
- For upstream denials: check IAM, ACLs, and scopes granted to the credential.
- For in-route denials: grant the principal the missing role(s) or scope(s) at your IdP, or relax the `.authorize()` requirement. The error message lists the missing roles/scopes. See [`.authorize()`](/docs/reference/operations/authorize).

## RC5016
Source payload parse failed

**Why it happens**  
A source adapter that converts raw bytes into a structured body (json, html, csv, jsonl, mail) could not parse the input. With the default `onParseError: 'fail'`, the adapter defers parsing to the route's pipeline so the failure is observable per exchange and the route's `.error()` handler can recover. Causes include malformed JSON, structurally-invalid CSV rows (mismatched columns), broken HTML matching, or malformed MIME.

**Suggestion**  
- Wire `.error()` on the route to log, repair, or quarantine the bad payload, then return a fallback value to keep the pipeline alive.
- Switch `onParseError` per adapter to control behaviour:
  - `'fail'` (default): the exchange fails; the route handles it. Streaming sources continue to the next item.
  - `'abort'`: the source aborts on the first parse failure (atomic-load semantics).
  - `'drop'`: the bad item fires `exchange:dropped` with `reason: 'parse-failed'` (lossy ingest with structured observability).
- For CSV chunked, inspect the row number on the captured error to identify the malformed row.

## RC5017
Optional peer dependency missing

**Why it happens**  
An adapter with a driver declared as an optional peer dependency was used, but the package is not installed. Examples: `cron()` requires `croner`, `html()` requires `cheerio`, `mail()` requires `imapflow` / `nodemailer` / `mailparser`, and the `agents()` / `skills()` markdown loaders in `@routecraft/ai` require `yaml` for front-matter parsing. The package itself loads without these peers; the error fires lazily on first use of the adapter so unrelated routes never need the drivers.

**Suggestion**  
Install the package the error message names. For example:

```bash
bun add croner   # or: npm install croner
```

The error message names the adapter (`cron`, `html`, ...) and the missing package, so the install line is copyable from the log. If you see this for a feature you do not use, find the route or capability that imports the adapter and remove it.

## RC5018
HTTP source request rejected

**Why it happens**  
The HTTP source (`http({ path, method })` via `defineConfig({ http })`) could not service a request at the adapter boundary. It covers: an oversized request body (returned to the client as `413 Payload Too Large`), a body that cannot be parsed for its declared `Content-Type` (`400 Bad Request`, e.g. malformed JSON or multipart), and an unsupported response body shape (`ReadableStream` / `AsyncIterable`, since SSE/streaming is not yet implemented).

**Suggestion**  
For 413, raise `http: { maxBodySize }` or have the client send a smaller payload. For 400, fix the request body so it matches the `Content-Type`. For streaming response bodies, return a buffered value for now (SSE support is tracked as a follow-up).

## RC5019
HTTP server bind failed

**Why it happens**  
The HTTP plugin could not bind the configured port/host. The usual cause is `EADDRINUSE` (another process, or a second `defineConfig({ http })` in the same process, already owns the port) or `EADDRNOTAVAIL` (the host is not one this machine can bind).

**Suggestion**  
Free the port or choose another via `http: { port }` (use `0` to let the OS assign one). Check that only one HTTP plugin is configured per context, and that `host` is an address this machine can bind.

## RC5020
Authorization failed: token expired during processing

**Why it happens**  
A mid-pipeline `.validate(authorize(...))` (or the pre-from `.authorize()` guard) ran on an exchange whose principal carries an `expiresAt` (Unix epoch seconds) that is beyond the configured `clockToleranceSec` window. The token was valid when verify ran at the route boundary, but a long-running step in between (LLM call, slow downstream, queue wait) outlived the credential. The framework refuses to authorize once the tolerance-adjusted expiry is exceeded.

The check is also raised fail-closed when either `expiresAt` or `clockToleranceSec` is non-finite (`NaN`, `Infinity`); a numeric-coercion bug must not silently bypass the guard.

The check is distinct from `RC5012` (no principal at all) and `RC5015` (principal failed a role / scope / predicate check) so clients can react accordingly: a `RC5020` signal almost always means "refresh and retry," whereas `RC5015` is a permanent denial under the current credentials.

**Suggestion**  
- The client should refresh the bearer and retry the request.
- To recover server-side, restructure the pipeline so `authorize()` runs before the slow step, or attach a fresh principal in a `.process()` step before the validator.
- If your source-side verifier (`jwt()` / `jwks()`) sets a `clockToleranceSec`, pass the same value to `authorize({ clockToleranceSec })` so the boundary and mid-pipeline checks agree on a token's validity window.
- If the principal genuinely has no expiry (e.g. an API key with infinite lifetime), leave `expiresAt` unset on the `Principal` so the check is skipped.

## RC5021
Principal enrichment failed

**Why it happens**  
The `userinfo` option on `mcpPlugin({})` could not enrich the verified principal. Causes include: a non-2xx response from the userinfo endpoint (rate limit, bearer scope insufficient, IdP outage), a network error reaching the userinfo or OIDC Discovery URL, malformed JSON, or a Discovery document that does not advertise a `userinfo_endpoint`. The framework is fail-closed: any enrichment error rejects the request rather than authorize on a partial principal.

**Suggestion**  
- Inspect the underlying cause attached to the error: it names the URL and HTTP status.
- Check that the bearer token has the scopes the IdP requires for `/userinfo` (typically `openid`, `email`, `profile`).
- If the IdP does not advertise OIDC Discovery (or advertises it without a `userinfo_endpoint`), pass an explicit `userinfo: "https://..."` or a function variant.
- Verify outbound network access from the MCP server to the IdP.

## RC5022
Userinfo sub invariant violated

**Why it happens**  
Per [OIDC Core §5.3.2](https://openid.net/specs/openid-connect-core-1_0.html#UserInfoResponse), the userinfo response MUST carry a `sub` claim equal to the verified token's `sub`. The framework throws RC5022 when the response is missing `sub` or when it differs from the token's `sub`. This guards against a compromised userinfo endpoint impersonating a different user on the principal, or a misconfigured userinfo URL paired with the wrong issuer.

This check applies only to URL and OIDC-discovery `userinfo` modes; the function variant is trusted by contract (the caller owns the backend).

**Suggestion**  
- Verify the `userinfo` URL matches the issuer of the bearer token. A common cause is configuring a `userinfo` URL for a different tenant or realm.
- Do not silence this error. If a legitimate IdP returns a non-standard subject under a different field, switch to a function-mode `userinfo` and map the response yourself.

## RC5023
Authorization failed: principal is not authentic

**Why it happens**  
`authorize()` found a principal on the exchange, but it was not established by a trusted origin. Authenticity is conferred only by a source-side verifier (`jwt()` / `jwks()` / `oauth()`) or by an explicit mint (`.authenticate()` / the `authenticate()` helper), which register the principal in a private set. A plain object written directly onto `headers["routecraft.auth.principal"]` (for example via `.process()` or `.header()`), or a copy made from an existing principal (`{ ...ex.principal, roles: ['admin'] }`, which is a different object and so not in the set), is treated as self-asserted and rejected. This makes establishing identity an explicit, greppable act and prevents a route from silently forging or escalating identity.

The check is distinct from `RC5012` (no principal at all) and `RC5015` (an authentic principal that lacks a required role / scope), so you can tell "forged / self-asserted" apart from "missing a role."

**Suggestion**  
- Mint the identity with the `.authenticate()` operation (or the `authenticate()` helper for mid-pipeline / custom-source use), which brands and freezes the principal.
- Let a source verifier attach it: `mcp({ auth: jwt(...) })` / `jwks(...)` / `oauth(...)`.
- In a custom source adapter that verifies identity itself, brand the resolved principal with `markAuthentic` before attaching it.
- Do not assign a plain object to the principal header and do not spread an existing principal to change its roles; both produce a non-authentic principal.

## RC5024
authenticate() called without a subject

**Why it happens**  
`authenticate()` (or the `.authenticate()` operation) was called with claims that have no `subject`, or an empty-string `subject`. Every minted identity must name the stable identity it represents, so the mint fails fast rather than producing an anonymous "authenticated" principal.

This is a programming error at the mint call site, distinct from `RC5023`, which fires later at `authorize()` when a principal reached the check without being established by a trusted origin.

**Suggestion**  
- Pass a non-empty `subject`: `authenticate({ subject: sender.address, roles: [...] })`.
- If the source cannot identify the caller, return `undefined` from the `.authenticate()` resolver to leave the exchange anonymous instead of minting an empty identity.

## AI1001
Agent block resolver failed

**Why it happens**  
A block's `value` resolver function threw, returned a non-string, or could not be invoked (no `CraftContext` available on the exchange). For `mode: "inject"` blocks this aborts the dispatch with `AI1001`; for `mode: "progressive"` blocks the same `AI1001` is reported back to the model as a tool error so it can self-correct.

This also fires when `client.forward()` is invoked from a resolver running on an exchange with no bound route (typically synthetic exchanges in tests).

**Suggestion**  
- Return a string (or `Promise<string>`) from the resolver. Throwing inside an `inject` resolver hard-fails the agent dispatch, so handle expected errors and return a sensible fallback string.
- For `progressive` resolvers, the model will see the error message and may retry; a descriptive message helps the model self-correct.
- When using `client.forward()` in tests, dispatch the agent through a real route so the exchange has a route binding, or construct the exchange via `DefaultExchange` with a populated route context.

## AI1002
Agent block / tool name collision with the reserved `_block_` prefix

**Why it happens**  
A block name or a user tool (fn id, direct route id, MCP tool name) starts with the framework-reserved `_block_` prefix used by synthetic block-loader tools. The reservation covers the whole `_block_` namespace, not just `_block_load_`, so future synthetic-tool kinds can land without another breaking reservation.

Also fires on duplicate block keys, empty-string block keys, or any other block-name collision detected at construction or dispatch.

**Suggestion**  
- Rename the offending block, fn, or route. The `_block_` prefix is for framework use only.
- For block keys, the `Blocks` record key is the block name; ensure it is a non-empty string and unique within the agent (defaults are merged in by name, with `false` removing).

## AI1003
Agent block misconfigured

**Why it happens**  
A block's shape is invalid at construction:
- `mode` is not `"inject"` or `"progressive"`.
- A `progressive`-mode block is missing the required `description`.
- `value` is neither a string nor a function.
- `lifetime` is set to a value other than `"dispatch"` or `"context"`.
- The `skills({ source })` builder was called with a missing or empty `source`, an invalid `mode`, or an invalid `lifetime`.

**Suggestion**  
- Inject-mode blocks: `{ mode: "inject", value: <string | function> }`.
- Progressive-mode blocks: `{ mode: "progressive", description: "...", value: <string | function> }`.
- Use the `BlockMode` and `BlockLifetime` types exported from `@routecraft/ai` to catch typos at the type level.

## RC5028
Cache provider failed

**Why it happens**  
The `.cache()` wrapper's provider threw while reading a value or while a custom provider executed its backend operations. Typical cause: a remote cache backend (Redis, etc.) is unreachable. Also raised by `MemoryCacheProvider.set` if called with `undefined` (the cache-miss sentinel), which is a contract violation.

**Suggestion**  
Inspect the underlying backend. Transient connectivity errors are retryable; consider wrapping the step with `.retry()` once that wrapper ships. If you hit the `undefined` set error, use `null` for an intentional empty value.

## RC5029
Cache key derivation failed

**Why it happens**  
The default `.cache()` key hashes `JSON.stringify(body)`, which fails on bodies containing functions, symbols, circular references, or `BigInt`. Also raised when a custom `key` function throws.

**Suggestion**  
Supply an explicit `key` function that returns a stable string identifier:

```ts
.cache({ key: (e) => String(e.body.id) })
```

This error is not retryable: the same body fails key derivation the same way every time.

## RC5030
Resource changed (precondition failed)

**Why it happens**  
A conditional write failed because the resource changed on the server since it was read (HTTP 412 / ETag mismatch, a mid-air collision). For example, two writers read the same CardDAV contact, the first commits, and the second's `update`/`save` is rejected because its `If-Match` ETag is now stale. This is **not retryable**: a blind retry sends the same stale precondition and fails again.

**Suggestion**  
Re-read the resource to pick up the current state and ETag, re-apply your change, and write again.

## RC5031
Exchange dropped before completion

**Why it happens**  
A request/reply caller (`client.sendDirect()` or an error handler's `forward()`) dispatched into a route that discarded the exchange instead of completing it: a `.filter()` rejected it or an `.error()` handler returned `recovery.drop()`. (Source-side `onParseError: 'drop'` never reaches this path; it drops inside the source's read loop, which has no request/reply caller.) A dropped exchange has no response body, so resolving would hand the caller back its own request; the framework rejects instead. This is **not retryable**: the same input is dropped the same way every time.

**Suggestion**  
If the caller should receive a value, recover with a body in `.error()` instead of `recovery.drop()`, or let the exchange pass the filter. If dropping is intended, catch the error and branch on `error.rc === 'RC5031'`.

## RC9901
Unknown error

**Why it happens**  
Unexpected failure without a specific code.

**Suggestion**  
Check logs and enable debug level.
