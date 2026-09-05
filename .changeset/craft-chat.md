---
"@routecraft/cli": minor
---

`craft chat <route> --session <id>` (the 0.7.0 slice of #599): a conversation with an agent session on a running instance, one message per line. Every line is a dispatch of `{ session, message }` to the route fronting the agent through the management door, and the reply is printed; a queued message is said to be queued. The conversation lives in the instance's store, so the loop can be killed and reattached with the same session id. Exit codes are `craft exec`'s. This release ships the print mode only: `--print` (`-p`) runs the line loop with no interface, piped input implies it, and the flagless form on a terminal refuses with the usage exit code until the interactive mode exists, so a script written today keeps its behaviour when it does.
