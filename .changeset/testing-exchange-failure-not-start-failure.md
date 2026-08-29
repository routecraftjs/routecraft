---
"@routecraft/testing": patch
---

`startAndWaitReady()` no longer rejects when a startup exchange fails while another source is still coming up.

`awaitRoutesReady` rejected on any `context:error`, which treated two different things as one: a route or plugin that failed to START, and an exchange that failed while RUNNING. The distinction was already in the payload, since the pipeline attaches the exchange it was executing and every start-path emitter leaves it undefined, so the guard now settles only on the bare form.

The conflation made a whole shape of route untestable. A route with a startup-firing source (`simple()` alongside a `cron()`, the usual way to run a scheduled probe once at boot) emits its first exchange immediately, while a sibling source that readies behind a lazy driver import does not. `route:started` waits for every source, so a failing startup exchange lands first, and the caller got a rejection out of `startAndWaitReady()` rather than a started context. The failure was in `errors` the whole time; a test asserting on it never reached the assertion.

It also read as a flake rather than as this. Which side won depended on whether the sibling's driver import was already warm, so the same test passed alone, passed in one file order, and failed in another.

A route or plugin that genuinely fails to start still rejects, and still fails fast rather than timing out with no cause named.
