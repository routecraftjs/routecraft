---
title: FAQ
---

Answers to common questions. {% .lead %}

## What is RouteCraft?

RouteCraft is a developer-first automation and integration framework that lets you build data processing pipelines using a fluent DSL. Think of it as Apache Camel for modern JavaScript/TypeScript applications.

## How do I run examples?

```bash
pnpm craft run ./examples
```

## What's the difference between a route and a context?

A **route** is a single data processing pipeline with a source, steps, and destinations. A **context** is the runtime environment that manages multiple routes, handles their lifecycle, and provides shared services like logging and storage.

## Can routes communicate with each other?

Yes! Use the `channel()` adapter to send data between routes:

```ts
// Producer route
craft()
  .id('producer')
  .from(source)
  .to(channel('my-channel'))

// Consumer route  
craft()
  .id('consumer')
  .from(channel('my-channel'))
  .to(destination)
```

## How do I handle errors in routes?

RouteCraft provides several error handling approaches:

- **Route isolation**: Failed routes don't affect other routes
- **Event monitoring**: Subscribe to `error` events for centralized error handling
- **Validation**: Use `.validate(schema)` to catch data issues early
- **Try/catch**: Use `.process()` with custom error handling logic

## What adapters are available?

RouteCraft includes many built-in adapters like `simple()`, `timer()`, `csv()`, `http()`, `fetch()`, and more.

For the complete list with examples and options, see [Adapters Reference](/docs/reference/adapters).

## How do I create custom adapters?

Implement the appropriate interface (`Source`, `Processor`, or `Destination`) and provide an `adapterId`:

```ts
class MyAdapter implements Source<string> {
  readonly adapterId = 'my.custom.adapter'
  
  async subscribe(context, handler, controller) {
    // Your implementation
  }
}
```
