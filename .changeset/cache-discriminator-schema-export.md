---
"@routecraft/routecraft": minor
---

`HeadersKeys.CACHE_DISCRIMINATOR` (`routecraft.cache.discriminator`) is folded into the default cache key beside the body when a source sets it, for a source that delivers several operations into one route. The default key changes shape for every route, so each default-key entry misses once after the upgrade. `standardSchemaFromJsonSchema`, the pass-through Standard Schema over a JSON Schema the remotes plugin already used, is exported.
