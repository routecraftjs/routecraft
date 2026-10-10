---
"@routecraft/routecraft": patch
---

`direct<T>()` now types a source without a schema: `craft().from(direct<{ name: string }>())` carries `{ name: string }` into the pipeline. Previously the type argument selected the enricher overloads and failed with `Expected 1 arguments, but got 0`. The type argument is compile-time only; a `.input({ body })` schema staged before `.from()` still wins (and is what the engine validates), and an explicit `.from<C>()` wins over both.
