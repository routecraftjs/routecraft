---
"@routecraft/routecraft": minor
---

A denied deferral is announced, and a parking error hook counts only for the routes it selects.

- **`route:exchange:denied`** fires at most once, from the process that wrote it, when a deferral is settled as denied: a resume refused because the route changed under the parked exchange (`RC5048`), a run cancelled around its store write (`RC5054`), or a park whose `notify` hook failed (`RC5067`). The payload is `{ routeId, exchangeId, correlationId, deferralId, reason }`, scoped to the deferred exchange as `route:exchange:expired` is.
- **`routeCanDefer` and `PluginRoutes.canDefer` follow a `mayDefer` hook's selectors.** An error hook declared with `mayDefer: true` makes deferrable only the routes its `routes` and `tags` select, as at dispatch; one hook aimed at one route no longer makes every route in the application read as deferrable. The start-time `RC5052` check names the route such a hook can park.
- **`RC5056` says what refused.** A plugin-driven revival whose re-identified principal is not the parked identity is logged and answered as a refused re-identification, not as a `.resume()` hook; the code, and the rule that the cause never leaves the log, are unchanged.
