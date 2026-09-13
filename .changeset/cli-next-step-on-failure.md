---
"@routecraft/routecraft": patch
"@routecraft/cli": patch
---

A failed `craft exec` now names the next step, and `start` and `run` take the logging flags directly.

The dispatch surface sends an error code and withholds the message on purpose. What was missing was any sign the message exists: a reader handed `RC5031` had nothing to do with it. A failed dispatch now names the instance whose log holds the sentence, and the errors page link is anchored at the code from the code's own metadata rather than pointing at the top of a long page. A code this process never registered still links to the index, which is the normal case for an ecosystem code and better than a confident link into the wrong page.

`craft start --log-level info` used to die on "unknown option", and `craft run app.ts --log-level info` was swallowed by the pass-through and handed to the route, so the flag that keeps logs off a stdio MCP server's protocol stream silently did nothing. Both commands now declare `--log-level` and `--log-file`, and the command's own flag wins over the global one. On `run` they go before the file, because everything after it still belongs to the route. The docs that told readers to write them after the file, including the stdio MCP remedy in the 0.4-to-0.5 migration, are corrected.

Every logged `RoutecraftError` repeated its own message, because `processError` adopts a thrown message as its own and keeps the original as the cause, and pino appends a cause to a message that already was the cause. The exact duplicate is collapsed; a cause that says something the error does not is still appended.
