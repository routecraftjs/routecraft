---
"@routecraft/routecraft": patch
---

A revived continuation that completes with a terminal body the deferral serializer refuses (a function, a class instance, a `Secret`) now logs one warning naming the deferral, the route and the offending path. The acknowledgment and the cached result already carried no body in that case, since the run's effects stand and the receipt is what is lost, but nothing said so; this line is the only record of the omission. The message a `failed` continuation records is cut to 1024 characters before it reaches the store, so a cause that interpolates an upstream response cannot grow the store by its size; `error.rc` is unchanged.
