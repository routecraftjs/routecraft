---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

Ports get a version that means something, the cache keeps its policy and gives up only its store, and a failed MCP call is named by what went wrong (#823).

- **A port's version is its contract.** The value read under `name@1` keeps its shape while that name exists; a change of shape ships as `name@2`. A committed snapshot of every exported port's value type holds it. `RESILIENCE` and `ENFORCEMENT` are provisional and outside the promise: both are due to be reshaped, so a plugin replacing either pins the minor it was written against.
- **`RC1119`.** A `replaces` that names a version nobody provides, while another version of that port is installed, is refused instead of silently displacing nothing. An unmet `requires` names the installed sibling version in `RC1104`.
- **Two ports are renamed.** `AUTHORITY` is `routecraft.authority@1` and `WEB_INGRESS` is `routecraft.web-ingress@1`. A plugin that imports the tokens needs no change; one that declared the old names as strings declares the new ones.
- **The authority has no fallback.** An exchange or a context with no `AUTHORITY` provider is refused rather than served by a process-wide default. The default plugin installs one in every application, so only a hand-built context without the default plugins is affected.
- **`CACHE_STORE` replaces `CACHE`.** The port is `routecraft.cache-store@1` and its value is a `CacheProvider`. The key, `when`, which outcomes are stored, the restore and the events are the kernel's at both scopes and no plugin replaces them. `CachePositions`, `CacheRun`, `CacheStep`, `cacheProvider()` and `bindCacheProvider()` are removed. A `provider` passed to one `.cache()` wins over the port for that call. A store on the port without `getOrCompute` is `RC1111`.
- **MCP transport failures are no longer `RC5003`.** A timeout is `RC5011`, a refused or dropped connection and an HTTP 5xx are `RC5010`, HTTP 429 is `RC5013`, and 401, 403 and 404 are `RC5012`, `RC5015` and `RC5014`. The first three are retryable, so `.retry()` around `mcp()` re-attempts them with the default `retryOn` and a circuit breaker counts them. A server that is not registered, a JSON-RPC error from the remote and any other HTTP 4xx stay `RC5003`.
- **`route:retry:stopped` says why.** A failed stop carries `reason` (`"exhausted"`, `"not-retryable"` or `"aborted"`) and `code`, the error's `RC` code when it has one, so a retry that never re-attempted is visible.
- **`isTransient(error)`** is exported: the rule `.retry()` and `.circuitBreaker()` apply by default, for a custom `retryOn` to extend.
