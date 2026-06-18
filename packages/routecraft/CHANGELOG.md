# @routecraft/routecraft

## 1.0.0

### Major Changes

- [#468](https://github.com/routecraftjs/routecraft/pull/468) [`6722d4a`](https://github.com/routecraftjs/routecraft/commit/6722d4a75de6c7d08ec438d97c1bc07ce780df98) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Harden `.retry()` backoff and remove the `exponential` option (breaking).

  `retry({ exponential })` is removed in favour of `factor`, a numeric growth multiplier: the wait before attempt `n` is `backoffMs * factor^(n - 1)`. Migrate `exponential: true` to `factor: 2` and `exponential: false` (or omitted) to `factor: 1` (the new default, fixed backoff). Passing `exponential` now throws `RC5003` at build with a migration hint. Two new options ship alongside: `maxBackoffMs` caps a single wait so a steep `factor` cannot grow unbounded, and `jitter` (`"none"` | `"full"` | a `0..1` fraction) randomises each wait to de-sync retry storms (it only ever shortens a wait, so the cap still holds).

### Minor Changes

- [#419](https://github.com/routecraftjs/routecraft/pull/419) [`9d9d7f0`](https://github.com/routecraftjs/routecraft/commit/9d9d7f0e4d61717d12760c0aff50ae4341ac5ab0) Thanks [@ex0b1t](https://github.com/ex0b1t)! - 0.6.0: prettier plugin for compact DSL chains, changesets-based release engineering (fixed core train, per-push canaries of the packages each merge changed, tokenless npm trusted publishing with provenance), and normalized workspace dependency ranges.

- [#468](https://github.com/routecraftjs/routecraft/pull/468) [`6722d4a`](https://github.com/routecraftjs/routecraft/commit/6722d4a75de6c7d08ec438d97c1bc07ce780df98) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Add the `concurrency` (bulkhead) wrapper operation.

  `.concurrency({ max })` bounds how many exchanges run an operation at once, the sibling of `.throttle()` (which bounds a rate). Dual-mode like the other resilience wrappers: step scope wraps the next step, route scope (before `.from()`) bounds the whole pipeline at the innermost resilience position (inside `.retry()` / `.timeout()`, so a slot is held per attempt and freed between retry backoffs). The default `queue` mode applies backpressure (bounded by `maxQueue`); `mode: "reject"` fails fast with the new `RC5026` (retryable). A `key` selector partitions the pool per user / tenant / pool (bounded by `maxKeys`). Emits `route:concurrency:queued` / `:acquired` / `:released` / `:rejected`.

- [#463](https://github.com/routecraftjs/routecraft/pull/463) [`f1896a5`](https://github.com/routecraftjs/routecraft/commit/f1896a542ae1a3bc4de76f5650ef0ab728ba6908) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Add the `sample` and `dedupe` flow-control operations.

  `sample({ every })` passes every Nth exchange and `sample({ intervalMs })` passes the first exchange in each time window, dropping the rest (silently, like a `filter` returning false). `dedupe(options?)` suppresses duplicate exchanges by a derived key with reserve-on-entry / commit-on-completion / release-on-failure semantics, an optional `key` function, and `ttl` / `maxKeys` bounds on the per-route in-memory key set. Both emit `route:operation:<op>:*` events. The default key derivation (SHA-256 of the body's JSON serialisation) is shared with `cache` via the new `hashExchangeBody` utility.

- [#434](https://github.com/routecraftjs/routecraft/pull/434) [`828e7c9`](https://github.com/routecraftjs/routecraft/commit/828e7c957637c896aca35073768fd0ec72ce13b8) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `.input({ body: schema })` now retypes the route builder: the following `.from(source)` opens the pipeline with the schema's inferred output type, so the duplicated `.from<T>()` generic is no longer needed (an explicit generic still overrides). Adds `PreFromTypedBuilder` and the shared `PreFromStaging` surface. The mail send payload gains threading and custom header support: `inReplyTo` (seeds `References` too), `references`, and `headers`, so agent replies stitch into the original email thread.
