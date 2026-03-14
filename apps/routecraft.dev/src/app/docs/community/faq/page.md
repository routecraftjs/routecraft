---
title: FAQ
---

Answers to common questions. {% .lead %}

## What is Routecraft?

Routecraft is a developer-first automation and integration framework for building data processing pipelines using a fluent DSL.

## What is the difference between a capability and a context?

A **capability** is a single data processing pipeline with a source, optional operations, and a destination. A **context** is the runtime environment that manages multiple capabilities, handles their lifecycle, and provides shared services like logging and storage.

## Can capabilities communicate with each other?

Yes -- use the `direct()` adapter to pass data between capabilities:

```ts
// Producer
craft()
  .id('producer')
  .from(source)
  .to(direct('my-channel'))

// Consumer
craft()
  .id('consumer')
  .from(direct('my-channel', {}))
  .to(destination)
```

See [Composing Capabilities](/docs/advanced/composing-capabilities) for fan-out, dynamic routing, and schema validation at the channel boundary.

## How do I handle errors?

- **Capability isolation** -- a failed capability does not affect others running in the same context
- **Event subscription** -- subscribe to the `error` event in `craft.config.ts` for centralized handling
- **Input validation** -- add a Zod `schema` to your source adapter (e.g. `direct()`, `mcp()`) to reject invalid data before any logic runs
- **Filtering** -- use `.filter(fn)` to drop exchanges that do not meet a condition

## What adapters are available?

Built-in adapters include `simple()`, `timer()`, `csv()`, `json()`, `file()`, `http()`, `direct()`, `log()`, `debug()`, and more.

For the complete list with options and signatures, see the [Adapters reference](/docs/reference/adapters).

## How do I create a custom adapter?

Implement the appropriate interface (`Source`, `Destination`, or `Processor`) and set an `adapterId`:

```ts
class MyAdapter implements Source<string> {
  readonly adapterId = 'my.custom.adapter'

  async subscribe(context, handler, controller, onReady?) {
    // emit exchanges by calling handler(value)
  }
}
```

See [Creating adapters](/docs/advanced/custom-adapters) for full examples including factory functions and multi-role adapters.

## How do I expose a capability as an MCP tool?

Use `mcp()` from `@routecraft/ai` as the source adapter and run the file with `craft run`. See [Expose as MCP](/docs/advanced/expose-as-mcp).
