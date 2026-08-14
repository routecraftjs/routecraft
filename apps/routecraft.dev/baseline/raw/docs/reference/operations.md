# Operations

Every verb in the Routecraft DSL. Each row opens its own reference page with the full signature, options, and examples.

```ts
craft()
  .id('my-route')
  .from(simple('x'))
  .filter((s) => s.length > 0)
  .transform((s) => s + '!')
  .to(log())
```

{% operations-index /%}

## Related

- [Adapters](/docs/reference/adapters) -- Sources, destinations, and transformers that connect operations to the outside world.
- [Events](/docs/reference/events) -- The lifecycle events emitted around every operation.
- [Errors](/docs/reference/errors) -- Error codes raised by operations and how to recover them.
