---
"@routecraft/routecraft": patch
---

An `event()` route no longer receives the events its own exchanges emit. A route watching `route:step:*` or `route:exchange:*` started an exchange for each event its own steps produced, and the process hung with the event loop never yielding. The route's own lifecycle events, such as `route:started`, are still delivered.
