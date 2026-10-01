---
"@routecraft/routecraft": patch
---

The default step-scope `.cache()` key now covers the options of every wrapper between the cache and its step, not only their kinds. Editing such a wrapper, for example the recovery value of an `.error()` handler or a `.retry()` policy that decides which failures are recovered, used to leave the key unchanged, so an external provider kept replaying entries the old wrapper produced. Each of those edits now misses and recomputes. Wrappers outside the cache (`.error(h).cache()`) still do not enter the key, because they cannot change what it stores. Default keys of step-scope caches that have a wrapper inside them change with this release, so those entries in an external provider miss once after the upgrade and are recomputed. Caches with no wrapper inside them, route-scope caches, and custom keys are unchanged.

`WrapperStep` subclasses must now implement `protected describeOptions(): unknown`, returning the options the wrapper was built with (callables included, `null` when it has none). It is abstract, so a custom wrapper that omits it fails to compile rather than silently dropping out of the cache key.
