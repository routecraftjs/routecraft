---
"@routecraft/routecraft": patch
---

The default `.cache()` key is now namespaced by where the cache sits and who is asking. It hashed the body alone, and the default provider is shared by the whole process, so two routes caching the same body answered for each other, and on an authenticated route a second user sending the same body received the first user's cached response. The key now covers the route id (plus, at step scope, the cache's site in the route), the principal's issuer and subject with its delegation actor chain when there is one, and the body. On a route with an `.id()`, entries already stored in an external provider miss once after the upgrade and are recomputed under the new key. An unnamed route gets a new generated id on every start, so its default key misses on every start; such a route now logs a warning telling you to add `.id()`. A custom `key` is unchanged and still used verbatim, so include the route and caller in it yourself when they matter. This ships as a patch, although it changes every default key, because it closes a cross-principal disclosure.

Route-scope `.cache()` (before `.from()`) is now refused at build with `RC5003` on a route whose pipeline contains `.authenticate()`. The cache check runs before the pipeline, so a hit returned a cached response without running authentication. Cache the expensive step with a step-scope `.cache()` after `.authenticate()` instead.

A default key on an exchange with no body (a bodiless `http()` GET, whose input lives in the `routecraft.http.params` and `routecraft.http.query` headers) still fails with `RC5029`, but the message now says there is nothing to key on and shows how to supply `key`, instead of claiming the body is not JSON-serialisable.
