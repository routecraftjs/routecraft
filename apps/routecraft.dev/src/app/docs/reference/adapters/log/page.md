---
title: log
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
log<T>(formatter?: (exchange: Exchange<T>) => unknown, options?: LogOptions): Destination<T, void>
```

Log messages to the console. Can be used as a destination with `.to()` or for side effects with `.tap()`.

```ts
// Log final result (default: logs exchange ID, body, and headers at info level)
.to(log())

// Log intermediate data without changing flow
.tap(log())

// Log with custom formatter function
.tap(log((ex) => `Exchange with id: ${ex.id}`))
.tap(log((ex) => `Body: ${JSON.stringify(ex.body)}`))
.tap(log((ex) => `Exchange with uuid: ${ex.headers.uuid}`))

// Log at different levels
.tap(log(undefined, { level: 'debug' }))
.tap(log((ex) => ex.body, { level: 'warn' }))
.tap(log((ex) => ex.body, { level: 'error' }))

// For debug logging, use the convenience helper
.tap(debug())
.tap(debug((ex) => ex.body))
```

**Log Levels:**
- `trace` - Most verbose
- `debug` - Development/debugging (use `debug()` helper)
- `info` - Default level
- `warn` - Warnings
- `error` - Errors
- `fatal` - Critical failures

**Output format:** 
- Without formatter: Logs exchange ID, body, and headers in a clean format
- With formatter: Logs the value returned by the formatter function
