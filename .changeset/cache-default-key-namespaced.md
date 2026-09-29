---
"@routecraft/routecraft": patch
---

The default `.cache()` key is now namespaced by where the cache sits and who is asking. It hashed the body alone, and the default provider is shared by the whole process, so two routes caching the same body answered for each other, and on an authenticated route a second user sending the same body received the first user's cached response. The key now covers the route id (plus the wrapped step's position at step scope), the principal's issuer and subject when there is one, and the body. Entries already stored in an external provider miss once after the upgrade and are recomputed under the new key. A custom `key` is unchanged and still used verbatim, so include the route and caller in it yourself when they matter.

A default key on an exchange with no body (a bodiless `http()` GET, whose input lives in the `routecraft.http.params` and `routecraft.http.query` headers) still fails with `RC5029`, but the message now says there is nothing to key on and shows how to supply `key`, instead of claiming the body is not JSON-serialisable.
