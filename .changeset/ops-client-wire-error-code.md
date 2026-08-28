---
"@routecraft/cli": patch
---

A failed dispatch now shows the framework error code the instance returned.

An error body carrying no `message` was reported only as "The instance answered 500", which made a route that refused the caller's own credential (`RC5038`) indistinguishable from one that crashed. The code belongs to a bounded, documented vocabulary and is safe to show, so it is shown, with a pointer to the reference page that explains it.
