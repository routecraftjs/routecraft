---
"@routecraft/routecraft": patch
---

`.to()` now infers the route's body type into a fetch-only adapter's callbacks, so `.to(llm(..., { user: (ex) => ex.body.text }))`, `.to(agent({ ... }))`, `.to(embedding(...))`, `.to(http({ url: (ex) => ... }))` and `.to(direct((ex) => ...))` no longer need a type argument on the factory. The Enricher overload is tried first and excludes anything with a `send` slot, so a dual-role adapter such as `file()` or a pseudo adapter still resolves to the Destination overload: send wins and the body is unchanged.
