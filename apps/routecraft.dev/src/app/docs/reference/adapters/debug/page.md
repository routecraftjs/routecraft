---
title: debug
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
debug<T>(formatter?: (exchange: Exchange<T>) => unknown, options?: Omit<LogOptions, "level">): Destination<T, void>
```

Convenience helper for debug-level logging. Equivalent to `log(formatter, { level: 'debug' })`.

```ts
// Log at debug level (default format)
.tap(debug())

// Log with custom formatter at debug level
.tap(debug((ex) => `Debug: ${JSON.stringify(ex.body)}`))
.tap(debug((ex) => ({ id: ex.id, bodySize: JSON.stringify(ex.body).length })))

// Use throughout development workflow
craft().from(source).tap(debug((ex) => `Input: ${JSON.stringify(ex.body)}`)).transform(processData).tap(debug((ex) => `Processed: ${JSON.stringify(ex.body)}`)).to(destination)
```

**Use cases:** Development debugging, verbose logging during troubleshooting
