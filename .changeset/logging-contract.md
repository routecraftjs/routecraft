---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
"@routecraft/cli": minor
"@routecraft/testing": minor
"create-routecraft": minor
---

Logging has one contract. `Logger` is a structural interface (`trace` to `fatal`, `child`, `isLevelEnabled`, optional `flush`) that names no pino type, so a pino instance, a winston wrapper or an object of your own with those members all satisfy it. Hand one to the application with `defineProject({ logger })` or `CraftConfig.logger`; every context, route, exchange and plugin logger is a child of it. With none configured the framework builds `defaultLogger()` on first use, from `LOG_LEVEL`, `LOG_FILE`, `LOG_STREAM`, `LOG_REDACT` and `craft.log.js` as before. `createLogger(options)` builds the same logger from options alone and reads no environment.

`.log(level, message, bindings?)` is the one way to write a line from inside a route. The level is `trace`, `debug`, `info` or `warn`, or a function of the exchange that returns one; the message is a fixed string; the bindings are a function of the exchange that returns the fields. Both functions get a read-only view of the exchange. A fixed level that is off skips the bindings function; a level function always runs, since it is what chooses the level, and the bindings function runs only when the level it chose is on. A line that cannot be built (the function throws, writes to the exchange, or returns a level that is not a step level) costs one `warn` and never the exchange. Editing, adding or removing a `.log()` does not change a route's continuation digest.

The default logger redacts `authorization`, `proxy-authorization`, `cookie` and `set-cookie` headers on every line, and a configured `redact` adds to that list; `DEFAULT_REDACT` exports it for a logger of your own. Its destinations are synchronous, and `context.stop()` awaits the root logger's `flush()` when it has one, so the last lines of a run are on disk before the process exits. `pino-pretty` is loaded in-process: asking for it (`pretty: true` or `PINO_PRETTY`) without it installed fails with `RC5017`, while the automatic development default falls back to JSON.

`testContext()` gives each context its own spy logger through `CraftConfig.logger`, so two test contexts in one process no longer share one. `SpyLogger` gains `isLevelEnabled`.

Breaking:

- The `logger` singleton export is gone. Use `context.logger`, `exchange.logger`, or `defaultLogger()` outside a context.
- The `log()` and `debug()` adapters and `LogOptions` are gone, and so is the `.debug()` step. `.to(log())`, `.tap(log())` and `.debug()` become `.log("info", "Message", (ex) => ({ ... }))`; a destination that only ended a route becomes `.to(noop())`.
- `.log()` no longer takes a formatter and options. It takes a level, a message and a bindings function.
- `PluginLogger` is gone; plugins type against `Logger`.
- An invalid `LOG_LEVEL` is reported on stderr and ignored, where it used to throw.
- Step events of a log line carry `operation: "log"` and the new `OperationType.OBSERVE`.
