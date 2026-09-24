---
"@routecraft/routecraft": patch
---

An `event()` route no longer receives the events its own exchanges cause. A route watching `route:step:*` or `route:exchange:*` started an exchange for each event its own steps produced, and the process hung with the event loop never yielding. The same held for a route watching `context:error` whose own step failed, and for the events of a route it calls through `direct()`. The route's own lifecycle events, such as `route:started`, are still delivered.
