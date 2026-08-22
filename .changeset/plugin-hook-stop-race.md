---
"@routecraft/routecraft": patch
---

A `stop()` racing boot no longer tears a plugin down while its own lifecycle
hook is still running.

A stop that arrived while a plugin's `apply()` or `start()` was awaiting
produced the order enter, teardown, resolve: the plugin was torn down (the
teardown walk keys off the applied set, so it was never skipped), but
anything the hook acquired after its last await point was acquired after the
release meant to cover it, and nothing released it afterwards. A process that
exits hides this because the OS reclaims; an embedder or a test suite
building successive contexts in one process keeps the interval or socket.

Shutdown now waits for the in-flight hook before teardown, on a promise
scoped to the plugin lifecycle hooks alone. It deliberately does not cover
`run()`, which for an indefinite route resolves only once the context stops.
The wait is unbounded, matching plugin teardown: a hook that never settles is
a defective plugin rather than a shutdown-policy question, and interrupting
instead would require every plugin author to write `start()` so it tolerates
teardown-before-completion.

Both lifecycle walks also re-check for a stop before each plugin, so a stop
mid-boot no longer applies or starts plugins that teardown has already
walked past.
