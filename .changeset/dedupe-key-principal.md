---
"@routecraft/routecraft": patch
---

The default `.dedupe()` key now includes who is asking. It hashed the body alone, so on an authenticated route a second user sending the same body as the first was dropped as a duplicate. The key now covers the principal's issuer and subject with its delegation actor chain when there is one, and the body, the same identity the default `.cache()` key uses. Exchanges without a principal dedupe as before, although the `key` reported on the `route:operation:dedupe:*` events is a different hash. A custom `key` is unchanged and still used verbatim, so include the caller in it yourself when callers must not dedupe each other.

A default key on an exchange with no body (a bodiless `http()` GET) still fails with `RC5033`, but the message now says there is nothing to key on and shows how to supply `key`, instead of claiming the body is not JSON-serialisable.
