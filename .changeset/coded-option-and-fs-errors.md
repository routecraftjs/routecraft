---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

Two kinds of failure that were bare errors carry a code.

**Breaking: an invalid `mcpPlugin()` or `llmPlugin()` option is `RC5003`.** The option validators threw `TypeError`, and in three places a plain `Error`, from the plugin factory, where nothing wraps a throw. They throw `RC5003` with the same message and a suggestion. Code that caught `TypeError` around either factory tests `isRoutecraftError(err) && err.rc === "RC5003"`; `instanceof Error` still matches.

**Breaking: a missing or unreadable path is `RC5014` or `RC5015`.** `file()`, `jsonl()`, `csv()` and `directory()` threw a plain `Error` for `ENOENT`, `ENOTDIR` and `EACCES`, so a route that wanted "a missing file means empty" had to match the message. The message is unchanged, the error is a `RoutecraftError`, and the errno error is its `cause`. A path below a regular file counts as missing. Any other read failure stays a plain error and now carries the errno error as `cause`.
