---
title: spy
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
spy<T>(): SpyAdapter<T>
```

Records all exchanges passing through it. Use as a destination, processor, or enricher to capture and assert on pipeline output.

```ts
import { spy } from '@routecraft/routecraft'

const spyAdapter = spy()

const route = craft()
  .id('my-route')
  .from(simple('payload'))
  .to(spyAdapter)

const t = await testContext().routes(route).build()
await t.test()

expect(spyAdapter.received).toHaveLength(1)
expect(spyAdapter.received[0].body).toBe('payload')
expect(spyAdapter.calls.send).toBe(1)
```

**Properties:**

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `received` | `Exchange[]` | `[]` | No | All exchanges recorded |
| `calls.send` | `number` | `0` | No | Number of times used as destination |
| `calls.process` | `number` | `0` | No | Number of times used as processor |
| `calls.enrich` | `number` | `0` | No | Number of times used as enricher |

**Methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `reset()` | `void` | Clear all recorded data |
| `lastReceived()` | `Exchange` | Most recent exchange |
| `receivedBodies()` | `unknown[]` | Array of just the body values |

See [Testing](/docs/introduction/testing) for full usage patterns.
