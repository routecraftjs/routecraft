---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
"@routecraft/testing": minor
---

Steps state their identity, and the continuation digest and the cache read it from one walk.

The digest that refuses a resume after a route changed (`RC5048`) used to miss an edit inside a `.choice()` branch or a `.multicast()` path, a `.dispatch()` strategy or weight, a wrapper such as `.retry()` and its options, a header's literal value, a schema in the tail, and the options of any helper that returns a closure (`authorize({ roles })` read the same whatever roles it was given). It also digested Routecraft's own source text, so an upgrade could move it. Both are fixed: every core step, wrapper and helper states `{ kind, version?, options? }`, options are encoded canonically, and a user's function is digested by its source. The refusal now names the first step that differs.

New public API: the `IDENTITY` symbol protocol for a raw step or adapter, `secret(value)` (digests as a constant, so rotating a credential re-asks nothing), `versioned(value, id)`, `step(fn, { identity: { version, options } })` for a plugin's catalogue step, the `Identity`, `IdentifiedStep` and `IdentifiedAdapter` types, and `describeIdentity(steps)` in `@routecraft/testing`. A route that defers logs the new `RC5071` warning once at start for each value in its tail the digest cannot see into. `.log()` and `.debug()` are left out of the digest. In `@routecraft/ai`, `tools()` and `fromFile()` are identified by their arguments.

**Breaking**

- Every deferral parked by an earlier release is refused once with `RC5048` on its first resume, into the deferred route's `.error()`, because its stored digest cannot be compared with the new format. Default `.cache()` keys change too, which costs one cold cache.
- A custom `WrapperStep` implements `protected readonly wrapperKind` and `protected identityOptions()` in place of `describeOptions()`.
- `NestedSteps.predicate` is `NestedSteps.selector`.
