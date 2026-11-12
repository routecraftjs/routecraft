---
"@routecraft/routecraft": minor
"@routecraft/cli": minor
---

`argv()` turns the command line of `craft run <file>` into one exchange. The `--field=value` arguments after the file become the body through the same parser `craft exec` uses, or JSON on stdin does when there are none (never both), the exchange carries no principal (a route with `.authorize()` fails with `RC5012` and exit code 1 unless a plugin supplies one), and the CLI prints the result with the `craft exec` renderer and exits with its codes: 0 completed or deferred, 1 failed or dropped, 2 usage or `.input()` failure, 4 refused by a validate hook or `.validate()` step. `--help` and `--format` (`pretty`, `json` or `raw`) after the file are read by the CLI and never reach the route, so a route cannot declare input fields with those names. A file can hold several `argv()` routes: `craft run <file> <route> --field=value` names the one to run, and the name is optional when there is only one. `--help` prints the chosen route's `.input()` fields, or lists the routes when there are several and none is named. The CLI stops the context after the one exchange, so a route can declare `argv()` beside `direct()` and `mcp()`; under `craft start` it is inert.

Breaking: the `RUNNER_ARGV` store key, which nothing read, is replaced by `RUNNER_INVOCATION`. `craft run` now logs to stderr, because its stdout carries the route's result; set `LOG_STREAM=stdout` (or `CRAFT_LOG_STREAM`), which the logger now reads, to keep the old stream.
