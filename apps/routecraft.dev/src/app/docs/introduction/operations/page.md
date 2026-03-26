---
title: Operations
---

The steps that transform, filter, and route data inside a capability. {% .lead %}

## What are operations?

Operations are the verbs of the DSL. They run in the order you write them -- the exchange passes through each one in sequence.

```ts
craft()
  .id('process-order')
  .from(timer({ intervalMs: 60_000 }))
  .transform((body) => normalise(body))
  .filter((ex) => ex.body.amount > 0)
  .enrich(http({ url: '/inventory' }))
  .tap(log())
  .to(destination)
```

## Operation categories

### Capability(Route)-level

Capability(Route)-level operations configure the capability itself. They go **before** `.from()` and apply to the entire capability, not to individual operations.

`.from()` is the most important one -- it defines the source adapter and creates the capability. Everything before it (`.id()`, `.batch()`) is configuration. Everything after it operates on exchanges.

### Transform

Transform operations reshape the data as it flows through the pipeline. They receive the current exchange and return a new version of it.

The distinction between them is how much of the exchange they expose. `.transform()` receives the body only and returns the new body -- the right choice for most data reshaping. `.process()` receives the full exchange, giving access to headers and context. `.map()` projects fields into a new typed shape. `.enrich()` calls an adapter and **merges** the result into the body rather than replacing it. `.header()` sets metadata without touching the body at all.

### Flow control

Flow control operations decide which exchanges continue and how they are split or merged.

`.filter()` drops exchanges that do not match a predicate -- the exchange simply does not continue downstream. Return `{ reason: "..." }` instead of `false` to record why in telemetry. `.validate()` checks the body against a StandardSchema (Zod, Valibot, ArkType); invalid exchanges are dropped with a reason describing which fields failed. `.split()` fans an array body out into one exchange per item, so each can be processed independently. `.aggregate()` collects those back into a single exchange. `.choice()` {% badge color="purple" %}planned{% /badge %} routes to different sub-pipelines based on conditions, like a switch statement for data flows.

### Wrappers

Wrappers modify the behaviour of the **next operation only**. They do not stand alone -- they must be followed by the operation they wrap, placed immediately before it.

`.retry()` re-runs the next operation on failure. `.timeout()` cancels it if it takes too long. `.throttle()` rate-limits it. `.delay()` adds a pause before it runs. `.onError()` {% badge color="purple" %}planned{% /badge %} catches any error and lets you provide a fallback exchange. `.cache()` {% badge color="purple" %}planned{% /badge %} skips re-running if the same input has been seen before.

Multiple wrappers can be stacked. They apply in outside-in order, so the first listed is the outermost. This means the order changes the semantics:

```ts
// Each retry attempt gets a fresh 5s timeout
.retry({ maxAttempts: 3 })
.timeout(5000)
.process(slowOp)

// Total 30s budget shared across all retry attempts
.timeout(30000)
.retry({ maxAttempts: 3 })
.process(flakyOp)
```

### Side effects

`.to()` sends the exchange to a destination adapter and ends the main pipeline. If the adapter returns a value, the body is replaced with it.

`.tap()` is fire-and-forget. It gets a deep copy of the exchange with the correlation ID preserved and runs in the background while the main pipeline continues immediately. Use `.tap()` for logging, metrics, and auditing that should never slow down the critical path.

---

## Related

{% quick-links %}

{% quick-link title="Operations reference" icon="presets" href="/docs/reference/operations" description="Full API: all operations with signatures, options, and examples." /%}

{% /quick-links %}
