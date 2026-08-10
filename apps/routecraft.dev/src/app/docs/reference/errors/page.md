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
Framework-enforced schema validation failed. The engine validates the route's `.input()` schema at filter chain position #4 (a failure is routable through `.error()` and otherwise takes the normal error path) and the route's `.output()` schema before the primary destination fires (routes to the error handler on failure). RC5002 also covers `validate()` steps, aggregators that received an empty array, and any validator that threw.

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
The operation exceeded its deadline: a `.timeout()` wrapper (step or route scope) expired before the wrapped work settled, or an adapter hit a network deadline (e.g. ETIMEDOUT).

**Suggestion**  
Increase the timeout or configure retry with backoff. Registered `retryable: true`, so a wrapping `.retry()` re-attempts timeouts by default.

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
- A route's `.authorize()` guard ran (or `.validate(authorize(...))` mid-pipeline), the exchange had a principal, but the principal was missing a required role, or a custom predicate returned `false`. A missing **scope** is not this code: it raises [`RC5038`](#rc-5038), because a role or predicate failure states something about who the subject is (permanent under current credentials), while a missing scope is recoverable through a consent or grant flow.

**Suggestion**  
- For upstream denials: check IAM, ACLs, and scopes granted to the credential.
- For in-route denials: grant the principal the missing role(s) at your IdP, or relax the `.authorize()` requirement. The error message lists the missing roles. See [`.authorize()`](/docs/reference/operations/authorize).

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

The check is distinct from `RC5012` (no principal at all) and `RC5015` (principal failed a role / predicate check; a missing scope is `RC5038`) so clients can react accordingly: an `RC5020` signal almost always means "refresh and retry," whereas `RC5015` is a permanent denial under the current credentials.

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

The check is distinct from `RC5012` (no principal at all), `RC5015` (an authentic principal that lacks a required role or fails a predicate), and `RC5038` (an authentic principal that lacks a required scope), so you can tell "forged / self-asserted" apart from "missing a role" and "missing a grantable scope."

**Suggestion**  
- Mint the identity with the `.authenticate()` operation (or the `authenticate()` helper for mid-pipeline / custom-source use), which brands and freezes the principal.
- Let a source verifier attach it: `mcp({ auth: jwt(...) })` / `jwks(...)` / `oauth(...)`.
- In a custom source adapter that verifies identity itself, brand the resolved principal with `markAuthentic` before attaching it.
- Do not assign a plain object to the principal header and do not spread an existing principal to change its roles; both produce a non-authentic principal.

## RC5024
authenticate() called with invalid claims

**Why it happens**  
Two cases, both programming errors at the mint call site:

1. **No subject.** The claims have no `subject`, or an empty-string `subject`. Every minted identity must name the stable identity it represents, so the mint fails fast rather than producing an anonymous "authenticated" principal.
2. **Delegation state passed to a mint.** The claims carry `actor` or `grantId`. Establishing identity and establishing who is acting for it are separate operations: `authenticate()` mints, [`delegate()`](/docs/reference/operations/delegate) delegates. Without this guard, spreading an already-delegated principal back through `authenticate()` would produce an authentic delegated identity while skipping every invariant `delegate()` enforces (the `mayAct` consent check, the scope intersection, truthful chain nesting).

Note that `mayAct` *is* accepted at mint. It describes the subject (who may act on their behalf), like `roles`, and is legitimately established when identity is resolved from a directory or a grant store.

Both are distinct from `RC5023`, which fires later at `authorize()` when a principal reached the check without being established by a trusted origin.

**Suggestion**  
- Pass a non-empty `subject`: `authenticate({ subject: sender.address, roles: [...] })`.
- To delegate, mint first and then delegate: `delegate(authenticate(claims), actorClaims, { scopes, grantId })`.
- If the source cannot identify the caller, return `undefined` from the `.authenticate()` resolver to leave the exchange anonymous instead of minting an empty identity.

## RC5025
Circuit breaker is open

**Why it happens**  
A route-scope or step-scope `.circuitBreaker()` exceeded its failure threshold and tripped open, so it is fast-failing subsequent calls without running the protected work until the cooldown elapses (then it admits a probe). Also raised when a half-open breaker is already at its probe capacity.

**Suggestion**  
- Wait for `cooldownMs` to elapse; the breaker then probes with a half-open call and closes on success.
- Configure a `fallback` to return a degraded result instead of throwing.
- Raise `failureThreshold` or `cooldownMs` if the breaker is too sensitive.
- Not retryable: an immediate retry would hit the same open breaker.

## RC5026
Concurrency limit exceeded

**Why it happens**  
A route-scope or step-scope `.concurrency()` bulkhead is at capacity and is failing the exchange fast rather than admitting more simultaneous work. In `reject` mode this fires the moment all `max` slots are busy; in the default `queue` mode it fires only when the wait line has also reached `maxQueue`.

**Suggestion**  
- Raise `max`, or switch to the default `queue` mode to apply backpressure instead of dropping.
- Cap the wait line with `maxQueue` for a middle ground between waiting forever and rejecting immediately.
- Handle it in `.error()` to shed load deliberately (for example, respond `503`).
- Retryable: a slot frees as soon as in-flight work completes, so an enclosing `.retry()` (which sits outside the bulkhead) can back off and re-acquire one.

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
A block name, or a user tool whose **final provider-facing name** starts with the framework-reserved `_block_` prefix used by synthetic block-loader tools. The reservation covers the whole `_block_` namespace, not just `_block__load__`, so future synthetic-tool kinds can land without another breaking reservation.

In practice this means fn ids, because a fn id reaches the provider verbatim. Capabilities and MCP tools acquire a `direct__` / `mcp__` wire prefix during resolution, so a route or remote tool named `_block_thing` resolves to `direct___block_thing` and never enters the reserved namespace.

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

## AI2001
MCP tool output violated its declared schema

**Why it happens**  
A route exposed with `.from(mcp())` declares `.output({ body })`, which the MCP server advertises as that tool's `outputSchema`, and the body it returned does not satisfy it. Clients parse `structuredContent` against the advertised schema, so the server refuses to publish the result and returns `isError: true` with the failing fields instead.

The route's own output validation catches most violations before the server sees them. This code is the same contract enforced at the boundary that advertised the schema, so a result reaching the server unvalidated is refused rather than published on trust.

**Suggestion**  
- Fix the route so its result matches the declared shape, or widen `.output()` to describe what the route actually returns.
- Drop the `.output()` declaration if the tool's result shape is genuinely open; nothing is advertised and nothing is checked.

## AI2002
MCP tool declined the request

**Why it happens**  
The route behind an MCP tool dropped the exchange instead of completing it: a `.filter()` rejected it, a `.choice()` matched no branch, the source's `onParseError` was `drop`, or an error handler returned `recovery.drop()`. A dropped exchange resolves with the body it came in with, so there is no result to return and the request body is not one.

This is the MCP-side equivalent of [RC5031](#rc-5031) on the direct and forward surfaces. The call comes back as `isError: true` saying the tool declined, and never as a successful result carrying the caller's own arguments back.

**Suggestion**  
- Give the route a branch that produces a result the caller can use (an empty list, an explicit not-found shape) if the caller should receive a value.
- Recover with a body in `.error()` rather than dropping, when the drop is an error path.
- Keep the drop if declining is genuinely correct for that input; the client sees an error result, which is the honest answer.

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
.cache({ key: (e) => String((e.body as { id: unknown }).id) })
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

## RC5032
Unsupported step outcome

**Why it happens**  
A step returned a `StepOutcome` whose `kind` the engine cannot schedule. In practice this only happens with a custom step: the built-in steps always return a supported kind. The `suspend` kind is declared on the outcome union (reserved for the future route-level suspend/resume feature) but is not implemented yet, so the executor rejects it rather than silently dropping the exchange. This is **not retryable**: the same step returns the same outcome every time.

**Suggestion**  
Return one of the supported outcomes from your step: `continue`, `complete`, `drop`, `branch`, or `fanOut`. Suspend/resume is not available yet; follow the tracking issue for when `suspend` becomes producible.

## RC5033
Dedupe key derivation failed

**Why it happens**  
The default `.dedupe()` key hashes `JSON.stringify(body)`, which fails on bodies containing functions, symbols, circular references, or `BigInt`. Also raised when a custom `key` function throws.

**Suggestion**  
Supply an explicit `key` function that returns a stable string identifier:

```ts
.dedupe({ key: (e) => String((e.body as { id: unknown }).id) })
```

This error is not retryable: the same body fails key derivation the same way every time.

## RC5034
Actor not permitted

**Why it happens**  
The exchange's principal carries an `actor` (a delegate, typically an agent, acting on the subject's behalf per RFC 8693 `act` semantics), and the route's `authorize({ actor })` specification does not admit it. The default specification is `'none'`: a capability is not reachable through delegation unless it declares otherwise, so any delegated principal is rejected until the route names its permitted actor(s). Also raised in the inverse case: a route that requires an actor (for example `actor: { profile: 'ai_agent' }`) rejects a direct call. Only the outermost actor is considered; nested prior actors in a chain are audit data (RFC 8693 section 4.1).

**Suggestion**  
Declare the permitted actor(s) on the route, matching by the `(issuer, subject)` pair:

```ts
.authorize({
  scopes: ['mail:send'],
  actor: ['none', { subject: 'agent:zoe', issuer: 'https://agents.example.com' }],
})
```

or have the permitted party perform the call. This is permanent under the current declaration; no retry or ceremony changes it.

## RC5035
Subject not permitted

**Why it happens**  
The principal's subject does not satisfy the route's `authorize({ subject })` constraint: wrong subject id, wrong issuer, or wrong entity profile (for example a route restricted to `subject: { profile: 'ai_agent' }` called by a human principal, or vice versa).

**Suggestion**  
Check the route's subject constraint against the caller's identity. This is permanent under current credentials.

## RC5036
Delegation chain too deep

**Why it happens**  
The principal's actor chain is longer than the route's `maxDelegationDepth` (default `1`, applied once the `actor` spec admits an actor at all). A re-delegated chain (user to agent to sub-agent) exceeds the default.

**Suggestion**  
Have an agent closer to the subject perform the call, or raise `maxDelegationDepth` on the route deliberately. Only the outermost actor is a policy input; deeper chains add audit surface, not authority.

## RC5037
Delegation refused by mayAct

**Why it happens**  
`delegate()` was asked to mint an actor that the subject's `mayAct` list (RFC 8693 section 4.4) does not permit. The subject has not consented to this party acting on their behalf. Matching uses the `(issuer, subject)` pair, so a same-named actor from a different issuer is also refused.

**Suggestion**  
Obtain the subject's consent through your grant flow, which adds the matching `mayAct` entry, then retry the delegation. Never widen `mayAct` without an explicit consent event.

## RC5038
Insufficient authority (recoverable)

**Why it happens**  
The principal is authentic and admitted, but lacks one or more scopes the route requires. Unlike a role failure (RC5015, permanent: no ceremony changes who the subject is), a missing scope is the one recoverable authorization failure: a consent or grant flow could add the scope and the call could be retried. This mirrors the RFC 9470 / RFC 6750 `insufficient_scope` challenge shape. For delegated principals, remember that scopes are intersected at every hop, so the missing scope may have been narrowed away by the delegation ceiling rather than absent from the subject.

**Suggestion**  
The cause error carries a machine-readable `missing.scopes` array listing exactly what is absent. Feed it to your consent flow (request a grant for those scopes), or grant them at the IdP, then retry.

## RC5039
HTTP webhook signature verification failed

**Why it happens**  
A route configured with `http({ signature: {...} })` received a request whose signature header was missing, did not match the raw body, or (for the `stripe-timestamped` scheme) carried a timestamp outside the tolerance window. The request was rejected with 401 before any route step ran.

**Suggestion**  
Check that the `secret` matches the provider's signing secret, the `header` name matches what the provider sends (e.g. `x-hub-signature-256`), and the `prefix` matches the provider's format (e.g. `"sha256="` for GitHub). If deliveries pass through a proxy or middleware that re-encodes the body, the signed bytes no longer match; verification must see the exact wire bytes.

This error is not retryable: the same delivery fails verification the same way every time.

## RC5040
Resume-token signing secret not configured

**Why it happens**  
A context whose routes can reach a durable `.suspend()` was built without a way to sign resume tokens. Resume tokens are the capability a suspended exchange hands its approver, so a context that cannot sign them cannot suspend anything. The check runs while the context is being built, not on the first suspend, so this surfaces at startup rather than on the first large payout.

**Suggestion**  
Set the `ROUTECRAFT_SUSPENSION_SECRET` environment variable, or pass `suspension: { secret }` to `defineConfig`. Prefer the environment variable: a secret in a config file is a secret in version control. Generate one with `openssl rand -base64 32`.

At least 32 bytes are required, and a shorter secret raises this same code. A resume token is a bearer capability, so any holder of one token can guess the secret offline with no rate limit and no server involvement; a dictionary-strength value falls in seconds, after which an attacker can mint a token for any suspension.

The secret is deliberately never generated into the store. A store compromise must not also yield the ability to forge resume tokens, and a store-resident key stops working the moment a second node appears. `testContext()`, `NODE_ENV=development` and `NODE_ENV=test` mint an ephemeral in-memory key so tests and local iteration need no setup; that key does not survive a restart, and the framework warns when it is used.

## RC5041
Resume token rejected

**Why it happens**  
The token presented to `.resume()` was malformed, carried a signature that does not verify, or named a format version this build does not understand. The three are reported as one error on purpose: telling a caller which check failed tells an attacker how far a forgery got.

**Suggestion**  
Resume with the exact token minted at suspend time. If the token is genuine, check that every node shares one signing secret: a token signed with a different secret is indistinguishable from a forged one, and an ephemeral development key is regenerated on every restart.

## RC5042
Exchange cannot be persisted for suspension

**Why it happens**  
Suspension writes the exchange to durable storage, so its `body` and `headers` must be plain JSON data. The error names the exact path that failed. Refused values are functions, symbols, bigints, non-finite numbers, circular references, class instances, and anything carrying the framework's `Secret` brand. A class instance is refused rather than downgraded because what would come back is a plain object wearing the same fields with none of the behaviour, and the failure would surface as a broken method call after resume instead of at the suspend.

`Date` is the exception: it round-trips faithfully through a tagged envelope, so a timestamp in the body is still a `Date` after resume.

**Suggestion**  
Move the offending value out of the exchange before the suspend point. Resolve it to a string, keep it in `context.store` (which outlives the exchange and is never serialized), or recompute it after resume. Blocks declared `lifetime: "context"` already live in the context store and are unaffected.

## RC5043
Principal restored from a suspension

**Why it happens**  
`authorize()` was given a principal that came back from durable storage with a resumed exchange. It is the recorded shape of an identity verified days ago, with nothing behind it now: no signature was re-checked, no expiry, no revocation lookup. The framework marks such principals restored precisely so this case is distinguishable, rather than letting a shape read off disk pass an authorization check.

**Suggestion**  
Put the authorization on the resume ingress route, where the answering principal is verified live, and read `ex.suspension.resumedBy` for the receipt. If a step after the suspend point genuinely needs an authorized identity, re-verify it there with `.authenticate()` from a checked credential.

Distinct from RC5023 (a self-asserted plain object) because the fix differs: re-verify, do not mint.


## RC5044
Suspension store operation failed

**Why it happens**  
The suspension store could not complete a read or write. The common causes are a duplicate suspension id (a bug in id derivation, since ids are minted one per suspend), a store file that is unwritable or out of disk, and a store file written by a newer Routecraft build than the one now running.

**Suggestion**  
Read the message, which names which of those it was. A schema-version mismatch means you have downgraded: run the newer build, or point `suspension.store.path` at a fresh file.

This error is deliberately not retryable. None of its causes clear on a second attempt, so a `.retry()` wrapper must not spend its budget on them.


## RC5045
Suspension store busy

**Why it happens**  
Another writer held the suspension store's write lock for longer than the busy timeout (5 seconds). Almost always this means more than one process is writing the same store file: two app instances sharing a volume, or an operator tool running against a live deployment.

**Suggestion**  
Unlike [`RC5044`](#rc-5044) this is transient, so it is registered retryable and a `.retry()` wrapper re-attempts it. If it persists, the store file has more than one writer: give each process its own store, or move to a backend built for concurrent writers once one ships.

## RC9901
Unknown error

**Why it happens**  
Unexpected failure without a specific code.

**Suggestion**  
Check logs and enable debug level.
