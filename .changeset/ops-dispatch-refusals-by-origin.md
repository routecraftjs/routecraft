---
"@routecraft/routecraft": patch
---

The ops dispatch door answers 404 and 409 only for its own checks of the route id in the path, never for the same codes raised inside the dispatched route.

A route whose pipeline fails with `RC5004` (a nested `direct()` call to an endpoint nothing answers) or `RC5060` was answered 404 or 409, and the 409 carried the error's message, which named another route. Both now answer 500 `{ "error": "dispatch failed", "code" }` with no message, like any other route failure, and `craft exec` reports them as a failed run rather than an unknown route or a usage error. An unknown id still answers 404, a route that cannot take a dispatch still answers 409 with `RC5060` and its remedy, and an imported route whose remote answers 404 still answers 404 when dispatched itself; a local route calling that imported route answers 500.
