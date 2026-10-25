---
"@routecraft/routecraft": patch
---

A resumed continuation's recorded outcome is bounded, and a lost receipt is said so.

- **A terminal body the deferral serializer refuses is warned about.** A revived continuation that completes with a function, a class instance or a `Secret` on its body logs one warning naming the deferral, the route and the offending path. The acknowledgment and the cached result already carried no body in that case, since the run's effects stand and the receipt is what is lost; this line is now the only record of the omission.
- **A `failed` continuation's `error.message` is cut to 1024 characters** before it reaches the store, so a cause that interpolates an upstream response cannot grow the store by its size. `error.rc` is unchanged.
